import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeUsername } from "@/auth/username";
import {
  TEST_OVERRIDE_TOKEN,
  type AdminAuditLog,
  type UserProfile,
  type UserStatus,
} from "@/auth/types";
import {
  LedgerAmountError,
  LedgerOversellError,
  normalizeLedgerEntry,
  occurredAtInstantISO,
  replayLedger,
  replayProduct,
  resolveLedgerAmounts,
  sortLedgerDesc,
  validatePriceSnapshotInput,
  type LedgerAppendRequest,
  type LedgerEntry,
  type PriceSnapshotRecord,
  type ProductPosition,
} from "@/domain/accounting";
import { getProduct } from "@/domain/catalog";
import type { PortfolioMeta } from "@/domain/types";
import type { DataScope } from "./actor";
import {
  IdempotencyConflictError,
  LedgerEntryNotActiveError,
  LedgerEntryNotFoundError,
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
  type CreateUserRequest,
  type LedgerAppendResult,
  type LedgerReplaceResult,
  type LedgerVerifyResult,
  type LedgerVoidResult,
  type ResolvedSession,
  type SessionPolicy,
  type SessionRecord,
  type SessionTouch,
  type StoredSessionSummary,
} from "./backend";

/**
 * YALNIZCA GELİŞTİRME/TEST İÇİN yerel kimlik doğrulama arka ucu.
 *
 * Supabase yapılandırması olmadan uygulamayı uçtan uca çalıştırabilmek ve
 * test edebilmek için vardır. Üretim derlemesinde KULLANILAMAZ (aşağıdaki
 * guard hata fırlatır); tek istisna açık test kaçış kapısıdır.
 *
 * Bilinçli ve belgelenmiş sapma: bu arka uç parolayı kendi deposunda scrypt
 * ile hash'leyerek tutar. Bu, ürün kuralının ("kendi parola hash sistemini
 * yazma") istisnasıdır ve YALNIZCA geliştirme test ikizi için geçerlidir.
 * Üretimde parola custody'si Supabase Auth'a aittir. Depo dosyası .gitignore
 * ile dışlanmıştır ve asla commit edilmez. Ayrıntı: docs/SECURITY.md
 */

interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  status: UserStatus;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  passwordSalt: string;
  passwordHash: string;
}

/** Oturum kaydı. Çerezdeki jetonun kendisi değil, özeti saklanır. */
interface StoredSession {
  id: string;
  tokenHash: string;
  /** Kimlik yenilemesinden sonra eski özet; validUntil dolana kadar kabul edilir. */
  previousTokenHash: string | null;
  previousTokenValidUntil: string | null;
  userId: string;
  /** Kaba cihaz tanımı; ham User-Agent veya IP saklanmaz. */
  deviceLabel: string;
  /** true: "oturumumu açık tut" (kalıcı çerez, kaydırmalı ömür). false: tarayıcı oturumu. */
  persistent: boolean;
  createdAt: string;
  lastSeenAt: string;
  renewedAt: string;
  rotatedAt: string;
  /** Etkin bitiş: kalıcıda kaydırmalı, kalıcı olmayanda mutlak. */
  expiresAt: string;
  /** Kalıcı olmayan oturumda hareketsizlik bitişi. */
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
  revokedAt: string | null;
}

/** Defter kaydı + sahibi. Değiştirilmez; yalnızca durumu değişir. */
interface StoredLedgerEntry extends LedgerEntry {
  userId: string;
  requestHash: string | null;
}

interface StoredSnapshot extends PriceSnapshotRecord {
  userId: string;
}

interface StoredPortfolio extends PortfolioMeta {
  userId: string;
}

interface StoreShape {
  version: number;
  users: StoredUser[];
  sessions: StoredSession[];
  audit: AdminAuditLog[];
  portfolios: StoredPortfolio[];
  /** İşlem defteri (append-only). */
  ledger: StoredLedgerEntry[];
  snapshots: StoredSnapshot[];
  /** Deterministik sıralama için artan defter sırası. */
  ledgerSequence: number;
}

const STORE_VERSION = 5;

function emptyStore(): StoreShape {
  return {
    version: STORE_VERSION,
    users: [],
    sessions: [],
    audit: [],
    portfolios: [],
    ledger: [],
    snapshots: [],
    ledgerSequence: 0,
  };
}

/** Eski (0.6) düz işlem kaydı biçimi — deftere taşınır. */
interface LegacyTransaction {
  id: string;
  userId: string;
  portfolioId: string;
  productId: string;
  side: "buy" | "sell";
  quantity: number;
  unit: "gram" | "adet";
  tradedAt: string;
  unitPrice: number;
  feeAmount: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

function legacyToLedger(row: LegacyTransaction, sequence: number): StoredLedgerEntry {
  const quantity = String(row.quantity);
  const unitPrice = String(row.unitPrice);
  const fees = String(row.feeAmount ?? 0);
  const amounts = resolveLedgerAmounts({
    kind: row.side === "sell" ? "SELL" : "BUY",
    quantity,
    pricingInputMode: "UNIT_PRICE",
    unitPrice,
    totalAmount: null,
    fees,
    workmanship: "0",
    baselineSnapshot: null,
  });
  return {
    id: row.id,
    userId: row.userId,
    portfolioId: row.portfolioId,
    productId: row.productId,
    kind: row.side === "sell" ? "SELL" : "BUY",
    quantity,
    unit: row.unit,
    occurredAt: row.tradedAt,
    occurredTime: null,
    occurredAtInstant: occurredAtInstantISO(row.tradedAt, null) ?? row.tradedAt,
    pricingInputMode: "UNIT_PRICE",
    ...amounts,
    costBasisOrigin: "ACTUAL",
    priceSnapshotId: null,
    priceSnapshot: null,
    note: row.note ?? "",
    status: "ACTIVE",
    voidedAt: null,
    voidReason: null,
    replacesTransactionId: null,
    replacedByTransactionId: null,
    clientRequestId: null,
    requestHash: null,
    ledgerSequence: sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Depo dosyası her zaman proje kökündeki .data klasöründedir (git dışı). */
export const LOCAL_STORE_DIR = ".data";
export const LOCAL_STORE_FILE = "auth-local.json";

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function hashToken(token: string): string {
  return scryptSync(token, "altin-takip-session", 32).toString("hex");
}

function toProfile(user: StoredUser): UserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export interface LocalBackendOptions {
  /** .data klasörü içindeki dosya adı. Verilmezse auth-local.json kullanılır. */
  fileName?: string;
  /** true ise diske yazmaz (testler için). */
  inMemory?: boolean;
  /** Yalnızca bootstrap CLI içindir. */
  allowInProduction?: boolean;
  /** Testlerde sabitlenebilir zaman kaynağı (kayıt zaman damgaları için). */
  now?: () => number;
}

export class LocalAuthBackend implements AuthBackend {
  readonly id = "local" as const;
  readonly label = "Yerel geliştirme sunucusu (Supabase değil)";
  readonly syncsAcrossDevices = false;

  private readonly filePath: string | null;
  private readonly clock: () => number;
  private store: StoreShape;

  /**
   * Kullanıcı başına yazma kuyruğu.
   *
   * Aşırı satış kontrolünün "oku-doğrula-yaz" dizisi eşzamanlı isteklerde
   * bölünemez olmalıdır. Supabase arka ucunda bu iş satır kilidiyle yapılır;
   * burada süreç içi bir kuyrukla aynı garanti sağlanır.
   */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(options: LocalBackendOptions = {}) {
    const testEscapeHatch = process.env.AUTH_ALLOW_LOCAL_BACKEND === TEST_OVERRIDE_TOKEN;
    if (process.env.NODE_ENV === "production" && !options.allowInProduction && !testEscapeHatch) {
      throw new Error(
        "Yerel kimlik doğrulama arka ucu üretim ortamında kullanılamaz. " +
          "Supabase yapılandırmasını tamamlayın.",
      );
    }
    // Yol sabit bir alt klasöre kapsanır; derleyicinin tüm projeyi izlemesini önler.
    this.filePath = options.inMemory
      ? null
      : join(
          /* turbopackIgnore: true */ process.cwd(),
          LOCAL_STORE_DIR,
          options.fileName ?? process.env.AUTH_LOCAL_STORE_FILE ?? LOCAL_STORE_FILE,
        );
    this.clock = options.now ?? (() => Date.now());
    this.store = this.read();
  }

  private nowISO(): string {
    return new Date(this.clock()).toISOString();
  }

  private read(): StoreShape {
    if (!this.filePath || !existsSync(this.filePath)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreShape> & {
        transactions?: LegacyTransaction[];
      };
      const merged: StoreShape = { ...emptyStore(), ...parsed, version: STORE_VERSION };
      const version = parsed.version ?? 0;
      if (version < 3) {
        // Çok eski oturum kayıtları taşınmaz; kullanıcı yeniden giriş yapar.
        merged.sessions = [];
      } else if (version < 4) {
        // 0.6 oturumları "kalıcı tercih verilmiş" kabul edilir; geçersiz kılınmaz.
        merged.sessions = merged.sessions.map((session) => ({
          ...session,
          persistent: session.persistent ?? true,
          idleExpiresAt: session.idleExpiresAt ?? null,
          absoluteExpiresAt: session.absoluteExpiresAt ?? session.expiresAt,
        }));
      }
      if (version < 4 && Array.isArray(parsed.transactions) && merged.ledger.length === 0) {
        // Düz işlem kayıtları deftere taşınır (ACTUAL / UNIT_PRICE).
        const sorted = [...parsed.transactions].sort((a, b) =>
          a.tradedAt === b.tradedAt ? a.createdAt.localeCompare(b.createdAt) : a.tradedAt.localeCompare(b.tradedAt),
        );
        merged.ledger = sorted.map((row, index) => legacyToLedger(row, index + 1));
        merged.ledgerSequence = sorted.length;
      }
      if (version < 5) {
        // Sprint 1.1: quoted/efektif fiyat ayrımı, occurredTime / occurredAtInstant alanları.
        merged.ledger = merged.ledger.map(
          (row) => normalizeLedgerEntry(row as unknown as Record<string, unknown>) as StoredLedgerEntry,
        );
      }
      delete (merged as { transactions?: unknown }).transactions;
      return merged;
    } catch {
      return emptyStore();
    }
  }

  private write(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), "utf8");
  }

  /** Dev sunucusunda birden çok istek arasında dosyayı tazeler. */
  private refresh(): void {
    if (this.filePath) this.store = this.read();
  }

  /** Aynı kullanıcı için yazma işlemlerini sıraya sokar (atomiklik garantisi). */
  private serialize<T>(userId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.writeQueues.get(userId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Kuyruğun hata yüzünden kırılmaması için sonucu yutan bir zincir tutulur.
    this.writeQueues.set(
      userId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async ensureReady(): Promise<void> {
    this.refresh();
  }

  // --- Kimlik doğrulama ---

  async verifyCredentials(username: string, password: string): Promise<UserProfile | null> {
    this.refresh();
    const normalized = normalizeUsername(username);
    const user = this.store.users.find((candidate) => candidate.username === normalized);
    if (!user) return null;
    if (!this.matches(user, password)) return null;
    return toProfile(user);
  }

  private matches(user: StoredUser, password: string): boolean {
    const expected = Buffer.from(user.passwordHash, "hex");
    const actual = Buffer.from(hashPassword(password, user.passwordSalt), "hex");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  async verifyPasswordForUser(userId: string, password: string): Promise<boolean> {
    this.refresh();
    const user = this.store.users.find((candidate) => candidate.id === userId);
    return user ? this.matches(user, password) : false;
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    this.refresh();
    const user = this.requireUser(userId);
    user.passwordSalt = randomBytes(16).toString("hex");
    user.passwordHash = hashPassword(newPassword, user.passwordSalt);
    user.updatedAt = this.nowISO();
    this.write();
  }

  private requireUser(userId: string): StoredUser {
    const user = this.store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("Kullanıcı bulunamadı.");
    return user;
  }

  // --- Oturum (politika: kalıcı / tarayıcı oturumu / admin) ---

  async createSession(
    userId: string,
    now: number,
    deviceLabel: string,
    policy: SessionPolicy,
  ): Promise<SessionRecord> {
    this.refresh();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + policy.absoluteLifetimeMs).toISOString();
    const idleExpiresAt =
      policy.idleTimeoutMs === null ? null : new Date(now + policy.idleTimeoutMs).toISOString();

    this.store.sessions.push({
      id,
      tokenHash: hashToken(token),
      previousTokenHash: null,
      previousTokenValidUntil: null,
      userId,
      deviceLabel,
      persistent: policy.persistent,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      renewedAt: timestamp,
      rotatedAt: timestamp,
      expiresAt,
      idleExpiresAt,
      absoluteExpiresAt: expiresAt,
      revokedAt: null,
    });
    this.write();
    return { id, token, userId, expiresAt, createdAt: timestamp, deviceLabel, persistent: policy.persistent };
  }

  /** Güncel özet veya tolerans süresi dolmamış eski özet ile eşleşen oturum. */
  private findSessionByTokenHash(tokenHash: string, now: number): StoredSession | undefined {
    return this.store.sessions.find(
      (candidate) =>
        candidate.tokenHash === tokenHash ||
        (candidate.previousTokenHash === tokenHash &&
          candidate.previousTokenValidUntil !== null &&
          Date.parse(candidate.previousTokenValidUntil) > now),
    );
  }

  async resolveSession(token: string, now: number): Promise<ResolvedSession | null> {
    this.refresh();
    const session = this.findSessionByTokenHash(hashToken(token), now);
    if (!session || session.revokedAt !== null) return null;

    const idleExpired = session.idleExpiresAt !== null && Date.parse(session.idleExpiresAt) <= now;
    const expired =
      Date.parse(session.expiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now;
    if (idleExpired || expired) {
      this.store.sessions = this.store.sessions.filter((candidate) => candidate.id !== session.id);
      this.write();
      return null;
    }

    const user = this.store.users.find((candidate) => candidate.id === session.userId);
    if (!user || user.status !== "active") return null;

    return {
      sessionId: session.id,
      profile: toProfile(user),
      expiresAt: session.expiresAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      persistent: session.persistent,
      lastSeenAt: session.lastSeenAt,
      renewedAt: session.renewedAt,
      rotatedAt: session.rotatedAt,
      createdAt: session.createdAt,
      deviceLabel: session.deviceLabel,
    };
  }

  async touchSession(sessionId: string, patch: SessionTouch): Promise<void> {
    this.refresh();
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.revokedAt !== null) return;
    session.lastSeenAt = patch.lastSeenAt;
    if (patch.expiresAt) {
      session.expiresAt = patch.expiresAt;
      if (session.persistent) session.absoluteExpiresAt = patch.expiresAt;
    }
    if (patch.renewedAt) session.renewedAt = patch.renewedAt;
    if (patch.idleExpiresAt) session.idleExpiresAt = patch.idleExpiresAt;
    this.write();
  }

  async rotateSession(sessionId: string, now: number, graceMs: number): Promise<string | null> {
    this.refresh();
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.revokedAt !== null) return null;

    const token = randomBytes(32).toString("base64url");
    session.previousTokenHash = session.tokenHash;
    session.previousTokenValidUntil = new Date(now + graceMs).toISOString();
    session.tokenHash = hashToken(token);
    session.rotatedAt = new Date(now).toISOString();
    this.write();
    return token;
  }

  async destroySession(token: string): Promise<void> {
    this.refresh();
    const tokenHash = hashToken(token);
    this.store.sessions = this.store.sessions.filter(
      (candidate) =>
        candidate.tokenHash !== tokenHash && candidate.previousTokenHash !== tokenHash,
    );
    this.write();
  }

  async destroySessionById(userId: string, sessionId: string): Promise<boolean> {
    this.refresh();
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter(
      (candidate) => !(candidate.id === sessionId && candidate.userId === userId),
    );
    const removed = before !== this.store.sessions.length;
    if (removed) this.write();
    return removed;
  }

  async destroyAllSessionsForUser(
    userId: string,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    this.refresh();
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter(
      (candidate) => candidate.userId !== userId || candidate.id === options.exceptSessionId,
    );
    const removed = before - this.store.sessions.length;
    if (removed > 0) this.write();
    return removed;
  }

  async listSessionsForUser(userId: string, now: number): Promise<StoredSessionSummary[]> {
    this.refresh();
    return this.store.sessions
      .filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt === null &&
          Date.parse(session.expiresAt) > now &&
          (session.idleExpiresAt === null || Date.parse(session.idleExpiresAt) > now),
      )
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        deviceLabel: session.deviceLabel,
        persistent: session.persistent,
      }));
  }

  async purgeExpiredSessions(now: number): Promise<number> {
    this.refresh();
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter(
      (session) =>
        session.revokedAt === null &&
        Date.parse(session.expiresAt) > now &&
        Date.parse(session.absoluteExpiresAt) > now &&
        (session.idleExpiresAt === null || Date.parse(session.idleExpiresAt) > now),
    );
    const removed = before - this.store.sessions.length;
    if (removed > 0) this.write();
    return removed;
  }

  // --- Profiller ---

  async getProfile(userId: string): Promise<UserProfile | null> {
    this.refresh();
    const user = this.store.users.find((candidate) => candidate.id === userId);
    return user ? toProfile(user) : null;
  }

  async findProfileByUsername(username: string): Promise<UserProfile | null> {
    this.refresh();
    const normalized = normalizeUsername(username);
    const user = this.store.users.find((candidate) => candidate.username === normalized);
    return user ? toProfile(user) : null;
  }

  async listProfiles(options: { search?: string; limit?: number } = {}): Promise<UserProfile[]> {
    this.refresh();
    const search = normalizeUsername(options.search ?? "");
    const rows = this.store.users
      .filter((user) => {
        if (!search) return true;
        return (
          user.username.includes(search) || normalizeUsername(user.displayName).includes(search)
        );
      })
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
    return rows.slice(0, options.limit ?? 200).map(toProfile);
  }

  async countAdmins(): Promise<number> {
    this.refresh();
    return this.store.users.filter((user) => user.role === "admin" && user.status === "active")
      .length;
  }

  async createUser(request: CreateUserRequest): Promise<UserProfile> {
    this.refresh();
    const username = normalizeUsername(request.username);
    if (this.store.users.some((user) => user.username === username)) {
      throw new Error("Bu kullanıcı adı zaten kullanılıyor.");
    }
    const salt = randomBytes(16).toString("hex");
    const timestamp = this.nowISO();
    const user: StoredUser = {
      id: randomUUID(),
      username,
      displayName: request.displayName.trim() || username,
      role: request.role,
      status: "active",
      mustChangePassword: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null,
      passwordSalt: salt,
      passwordHash: hashPassword(request.temporaryPassword, salt),
    };
    this.store.users.push(user);
    // Profil ile portföy aynı yazma adımında hazırlanır (tetikleyici davranışı).
    this.provisionDefaults(user.id);
    this.write();
    return toProfile(user);
  }

  async setStatus(userId: string, status: UserStatus): Promise<UserProfile> {
    this.refresh();
    const user = this.requireUser(userId);
    user.status = status;
    user.updatedAt = this.nowISO();
    this.write();
    return toProfile(user);
  }

  async setMustChangePassword(userId: string, value: boolean): Promise<UserProfile> {
    this.refresh();
    const user = this.requireUser(userId);
    user.mustChangePassword = value;
    user.updatedAt = this.nowISO();
    this.write();
    return toProfile(user);
  }

  async recordLogin(userId: string): Promise<void> {
    this.refresh();
    const user = this.requireUser(userId);
    user.lastLoginAt = this.nowISO();
    this.write();
  }

  async deleteUser(userId: string): Promise<void> {
    this.refresh();
    this.store.users = this.store.users.filter((user) => user.id !== userId);
    this.store.sessions = this.store.sessions.filter((session) => session.userId !== userId);
    this.store.portfolios = this.store.portfolios.filter((row) => row.userId !== userId);
    // Hesap silme: cascade — defter ve anlık görüntüler de gider (tek hard delete durumu).
    this.store.ledger = this.store.ledger.filter((row) => row.userId !== userId);
    this.store.snapshots = this.store.snapshots.filter((row) => row.userId !== userId);
    this.write();
  }

  // --- Denetim kaydı ---

  async appendAudit(entry: Omit<AdminAuditLog, "id" | "createdAt">): Promise<AdminAuditLog> {
    this.refresh();
    const row: AdminAuditLog = { ...entry, id: randomUUID(), createdAt: this.nowISO() };
    this.store.audit.push(row);
    this.write();
    return row;
  }

  async listAudit(limit = 100): Promise<AdminAuditLog[]> {
    this.refresh();
    return [...this.store.audit]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  // --- Portföy (DataScope ile korunur) ---

  /** Profil için varsayılan portföyü hazırlar (idempotent). Supabase tetikleyicisinin ikizi. */
  private provisionDefaults(userId: string): number {
    if (this.store.portfolios.some((row) => row.userId === userId)) return 0;
    const timestamp = this.nowISO();
    this.store.portfolios.push({
      userId,
      id: randomUUID(),
      name: "Portföyüm",
      displayName: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return 1;
  }

  async provisionMissingDefaults(): Promise<number> {
    this.refresh();
    let repaired = 0;
    for (const user of this.store.users) {
      if (this.provisionDefaults(user.id) > 0) repaired += 1;
    }
    if (repaired > 0) this.write();
    return repaired;
  }

  async getPortfolio(scope: DataScope): Promise<PortfolioMeta> {
    this.refresh();
    const existing = this.store.portfolios.find((row) => row.userId === scope.userId);
    if (!existing) {
      // GET yolu veri OLUŞTURMAZ; Supabase davranışıyla aynı.
      throw new PortfolioNotProvisionedError(scope.userId);
    }
    const { userId: _ignored, ...portfolio } = existing;
    return portfolio;
  }

  async updatePortfolio(
    scope: DataScope,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    await this.getPortfolio(scope);
    const row = this.store.portfolios.find((candidate) => candidate.userId === scope.userId);
    if (!row) throw new Error("Portföy bulunamadı.");
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    row.updatedAt = this.nowISO();
    this.write();
    const { userId: _ignored, ...portfolio } = row;
    return portfolio;
  }

  // --- İşlem defteri (append-only; hard delete YOK) ---

  private userLedger(userId: string): LedgerEntry[] {
    return this.store.ledger
      .filter((row) => row.userId === userId)
      .map(({ userId: _ignored, requestHash: _hash, ...entry }) => entry);
  }

  private static requestHashOf(request: LedgerAppendRequest): string {
    const { clientRequestId: _id, baselineSnapshot: _snap, ...rest } = request;
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
    return createHash("sha256").update(canonical).digest("hex");
  }

  private positionOf(entries: readonly LedgerEntry[], productId: string): ProductPosition {
    try {
      return replayProduct(entries, productId);
    } catch (error) {
      if (error instanceof LedgerOversellError) {
        throw new OversellError(error.productId, error.available);
      }
      throw error;
    }
  }

  async listLedger(scope: DataScope): Promise<LedgerEntry[]> {
    this.refresh();
    return sortLedgerDesc(this.userLedger(scope.userId));
  }

  async listPositions(scope: DataScope): Promise<ProductPosition[]> {
    this.refresh();
    const positions = replayLedger(this.userLedger(scope.userId));
    return [...positions.values()].sort((a, b) => (a.productId < b.productId ? -1 : 1));
  }

  /** Deftere kayıt yazar. Çağıran taraf serialize() içinde olmalıdır. */
  private buildEntry(
    scope: DataScope,
    portfolioId: string,
    request: LedgerAppendRequest,
    options: { replacesTransactionId?: string | null } = {},
  ): { entry: StoredLedgerEntry; snapshot: StoredSnapshot | null } {
    const product = getProduct(request.productId);
    if (!product) throw new Error(`Bilinmeyen altın ürünü: ${request.productId}`);
    if (request.unit !== product.unit) {
      throw new Error(`${product.name} için birim "${product.unit}" olmalıdır.`);
    }

    let snapshot: StoredSnapshot | null = null;
    if (request.costBasisOrigin === "MARKET_BASELINE") {
      if (request.kind !== "OPENING_BALANCE" || !request.baselineSnapshot) {
        throw new Error("Piyasa başlangıcı yalnızca mevcut altın için ve fiyat anlık görüntüsüyle kullanılabilir.");
      }
      const snapshotError = validatePriceSnapshotInput(request.baselineSnapshot, request.productId, Date.now());
      if (snapshotError) throw new LedgerAmountError(snapshotError);
      snapshot = {
        ...request.baselineSnapshot,
        id: randomUUID(),
        createdAt: this.nowISO(),
        userId: scope.userId,
      };
    }

    const amounts = resolveLedgerAmounts(request);
    const timestamp = this.nowISO();
    this.store.ledgerSequence += 1;

    const { userId: _ignored, ...snapshotRecord } = snapshot ?? ({} as StoredSnapshot);
    const entry: StoredLedgerEntry = {
      id: randomUUID(),
      userId: scope.userId,
      portfolioId,
      productId: request.productId,
      kind: request.kind,
      quantity: request.quantity,
      unit: product.unit,
      occurredAt: request.occurredAt,
      occurredTime: request.occurredTime,
      occurredAtInstant: request.occurredAtInstant,
      pricingInputMode: request.pricingInputMode,
      ...amounts,
      costBasisOrigin: request.costBasisOrigin,
      priceSnapshotId: snapshot?.id ?? null,
      priceSnapshot: snapshot ? (snapshotRecord as PriceSnapshotRecord) : null,
      note: request.note,
      status: "ACTIVE",
      voidedAt: null,
      voidReason: null,
      replacesTransactionId: options.replacesTransactionId ?? null,
      replacedByTransactionId: null,
      clientRequestId: request.clientRequestId,
      requestHash: LocalAuthBackend.requestHashOf(request),
      ledgerSequence: this.store.ledgerSequence,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { entry, snapshot };
  }

  private replayResult(userId: string, request: LedgerAppendRequest): LedgerAppendResult | null {
    if (!request.clientRequestId) return null;
    const existing = this.store.ledger.find(
      (row) => row.userId === userId && row.clientRequestId === request.clientRequestId,
    );
    if (!existing) return null;
    if (existing.requestHash !== LocalAuthBackend.requestHashOf(request)) {
      throw new IdempotencyConflictError(request.clientRequestId);
    }
    const { userId: _ignored, requestHash: _hash, ...entry } = existing;
    return {
      entry,
      position: this.positionOf(this.userLedger(userId), existing.productId),
      replayed: true,
    };
  }

  async appendLedgerEntry(scope: DataScope, request: LedgerAppendRequest): Promise<LedgerAppendResult> {
    return this.serialize(scope.userId, async () => {
      const portfolio = await this.getPortfolio(scope);
      this.refresh();

      const replayed = this.replayResult(scope.userId, request);
      if (replayed) return replayed;

      const { entry, snapshot } = this.buildEntry(scope, portfolio.id, request);
      const { userId: _ignored, requestHash: _hash, ...plain } = entry;
      // Negatif miktar kontrolü: kronolojik HER an (geçmiş tarihli kayıt dâhil).
      const position = this.positionOf([...this.userLedger(scope.userId), plain], request.productId);

      if (snapshot) this.store.snapshots.push(snapshot);
      this.store.ledger.push(entry);
      this.write();
      return { entry: plain, position, replayed: false };
    });
  }

  private requireActiveEntry(userId: string, entryId: string): StoredLedgerEntry {
    const row = this.store.ledger.find((candidate) => candidate.id === entryId && candidate.userId === userId);
    // Başkasına ait veya olmayan kayıt AYNI hatayı verir (kimlik tahmini bilgi sızdırmaz).
    if (!row) throw new LedgerEntryNotFoundError(entryId);
    if (row.status !== "ACTIVE") throw new LedgerEntryNotActiveError(entryId);
    return row;
  }

  async voidLedgerEntry(scope: DataScope, entryId: string, reason: string): Promise<LedgerVoidResult> {
    return this.serialize(scope.userId, () => {
      this.refresh();
      const row = this.requireActiveEntry(scope.userId, entryId);
      const voidedAt = this.nowISO();
      const candidate: StoredLedgerEntry = {
        ...row,
        status: "VOID",
        voidedAt,
        voidReason: reason.slice(0, 140),
        updatedAt: voidedAt,
      };

      // Geçmiş bir alışın iptali sonraki satışı negatife düşürüyorsa TÜMÜ reddedilir; defter değişmez.
      const projected = this.userLedger(scope.userId).map((entry) =>
        entry.id === entryId ? stripStored(candidate) : entry,
      );
      const position = this.positionOf(projected, row.productId);

      Object.assign(row, candidate);
      this.write();
      return { entry: stripStored(row), position };
    });
  }

  async replaceLedgerEntry(
    scope: DataScope,
    entryId: string,
    request: LedgerAppendRequest,
  ): Promise<LedgerReplaceResult> {
    return this.serialize(scope.userId, async () => {
      const portfolio = await this.getPortfolio(scope);
      this.refresh();
      const row = this.store.ledger.find((candidate) => candidate.id === entryId && candidate.userId === scope.userId);
      if (!row) throw new LedgerEntryNotFoundError(entryId);

      // Idempotent tekrar
      if (request.clientRequestId) {
        const existing = this.store.ledger.find(
          (candidate) => candidate.userId === scope.userId && candidate.clientRequestId === request.clientRequestId,
        );
        if (existing) {
          if (existing.replacesTransactionId !== entryId) {
            throw new IdempotencyConflictError(request.clientRequestId);
          }
          const replayed = this.replayResult(scope.userId, request)!;
          return { voided: stripStored(row), entry: replayed.entry, positions: [replayed.position] };
        }
      }

      if (row.status !== "ACTIVE") throw new LedgerEntryNotActiveError(entryId);

      const { entry: created, snapshot } = this.buildEntry(scope, portfolio.id, request, {
        replacesTransactionId: entryId,
      });
      const voidedAt = this.nowISO();
      const replaced: StoredLedgerEntry = {
        ...row,
        status: "REPLACED",
        voidedAt,
        voidReason: "Düzeltildi",
        replacedByTransactionId: created.id,
        updatedAt: voidedAt,
      };

      const projected = [
        ...this.userLedger(scope.userId).map((entry) => (entry.id === entryId ? stripStored(replaced) : entry)),
        stripStored(created),
      ];
      const positions = [this.positionOf(projected, row.productId)];
      if (created.productId !== row.productId) {
        positions.push(this.positionOf(projected, created.productId));
      }

      Object.assign(row, replaced);
      if (snapshot) this.store.snapshots.push(snapshot);
      this.store.ledger.push(created);
      this.write();
      return { voided: stripStored(row), entry: stripStored(created), positions };
    });
  }

  async voidAllLedgerEntries(scope: DataScope, reason: string): Promise<number> {
    return this.serialize(scope.userId, () => {
      this.refresh();
      const timestamp = this.nowISO();
      let count = 0;
      for (const row of this.store.ledger) {
        if (row.userId !== scope.userId || row.status !== "ACTIVE") continue;
        row.status = "VOID";
        row.voidedAt = timestamp;
        row.voidReason = reason.slice(0, 140);
        row.updatedAt = timestamp;
        count += 1;
      }
      if (count > 0) this.write();
      return count;
    });
  }

  async verifyLedger(scope: DataScope): Promise<LedgerVerifyResult> {
    this.refresh();
    // Yerel arka uçta pozisyon her zaman defterden türetilir; ayrı projeksiyon yoktur.
    const positions = replayLedger(this.userLedger(scope.userId));
    return { checked: positions.size, mismatches: [] };
  }
}

function stripStored(row: StoredLedgerEntry): LedgerEntry {
  const { userId: _ignored, requestHash: _hash, ...entry } = row;
  return entry;
}
