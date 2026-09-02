import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeUsername } from "@/auth/username";
import {
  SESSION_ROLLING_LIFETIME_MS,
  TEST_OVERRIDE_TOKEN,
  type AdminAuditLog,
  type UserProfile,
  type UserStatus,
} from "@/auth/types";
import { requireProduct } from "@/domain/catalog";
import { findNegativeHolding } from "@/domain/portfolio";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import type { DataScope } from "./actor";
import {
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
  type CreateUserRequest,
  type ResolvedSession,
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

/** Kalıcı oturum kaydı. Çerezdeki jetonun kendisi değil, özeti saklanır. */
interface StoredSession {
  id: string;
  tokenHash: string;
  /** Kimlik yenilemesinden sonra eski özet; validUntil dolana kadar kabul edilir. */
  previousTokenHash: string | null;
  previousTokenValidUntil: string | null;
  userId: string;
  /** Kaba cihaz tanımı; ham User-Agent veya IP saklanmaz. */
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  renewedAt: string;
  rotatedAt: string;
  /** Kaydırmalı bitiş zamanı. */
  expiresAt: string;
  revokedAt: string | null;
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
  transactions: (Transaction & { userId: string })[];
}

const STORE_VERSION = 3;

function emptyStore(): StoreShape {
  return {
    version: STORE_VERSION,
    users: [],
    sessions: [],
    audit: [],
    portfolios: [],
    transactions: [],
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
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreShape>;
      const merged: StoreShape = { ...emptyStore(), ...parsed, version: STORE_VERSION };
      // Eski sürümün cihaz modlu / hareketsizlik süreli oturumları taşınmaz;
      // kullanıcı bir kez yeniden giriş yapar ve kalıcı oturum alır.
      if ((parsed.version ?? 0) < STORE_VERSION) merged.sessions = [];
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

  // --- Oturum (kalıcı, kaydırmalı, yenilenen kimlik) ---

  async createSession(userId: string, now: number, deviceLabel: string): Promise<SessionRecord> {
    this.refresh();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + SESSION_ROLLING_LIFETIME_MS).toISOString();

    this.store.sessions.push({
      id,
      tokenHash: hashToken(token),
      previousTokenHash: null,
      previousTokenValidUntil: null,
      userId,
      deviceLabel,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      renewedAt: timestamp,
      rotatedAt: timestamp,
      expiresAt,
      revokedAt: null,
    });
    this.write();
    return { id, token, userId, expiresAt, createdAt: timestamp, deviceLabel };
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

    // Hareketsizlik sınırı YOKTUR; yalnızca kaydırmalı bitiş zamanı kontrol edilir.
    if (Date.parse(session.expiresAt) <= now) {
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
      lastSeenAt: session.lastSeenAt,
      renewedAt: session.renewedAt,
      rotatedAt: session.rotatedAt,
      deviceLabel: session.deviceLabel,
    };
  }

  async touchSession(sessionId: string, patch: SessionTouch): Promise<void> {
    this.refresh();
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.revokedAt !== null) return;
    session.lastSeenAt = patch.lastSeenAt;
    if (patch.expiresAt) session.expiresAt = patch.expiresAt;
    if (patch.renewedAt) session.renewedAt = patch.renewedAt;
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
          Date.parse(session.expiresAt) > now,
      )
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        deviceLabel: session.deviceLabel,
      }));
  }

  async purgeExpiredSessions(now: number): Promise<number> {
    this.refresh();
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter(
      (session) => session.revokedAt === null && Date.parse(session.expiresAt) > now,
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
    this.store.transactions = this.store.transactions.filter((row) => row.userId !== userId);
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

  async listTransactions(scope: DataScope): Promise<Transaction[]> {
    this.refresh();
    return this.store.transactions
      .filter((row) => row.userId === scope.userId)
      .map(({ userId: _ignored, ...tx }) => tx);
  }

  /**
   * Birim tutarlılığı ve aşırı satış kontrolü.
   * Kontrol ile yazma arasına başka bir isteğin girmesi serialize() ile engellenir.
   */
  private assertConsistent(rows: Transaction[], input: TransactionInput): void {
    const product = requireProduct(input.productId);
    if (input.unit !== product.unit) {
      throw new Error(`${product.name} için birim "${product.unit}" olmalıdır.`);
    }
    const negative = findNegativeHolding(rows);
    if (negative) {
      const bought = rows
        .filter((row) => row.productId === negative.productId && row.side === "buy")
        .reduce((sum, row) => sum + row.quantity, 0);
      const sold = rows
        .filter((row) => row.productId === negative.productId && row.side === "sell")
        .reduce((sum, row) => sum + row.quantity, 0);
      throw new OversellError(negative.productId, Math.max(0, bought - sold + input.quantity));
    }
  }

  async createTransaction(scope: DataScope, input: TransactionInput): Promise<Transaction> {
    return this.serialize(scope.userId, async () => {
      const portfolio = await this.getPortfolio(scope);
      this.refresh();
      const timestamp = this.nowISO();
      const transaction: Transaction = {
        ...input,
        id: randomUUID(),
        portfolioId: portfolio.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const existing = this.store.transactions
        .filter((row) => row.userId === scope.userId)
        .map(({ userId: _ignored, ...tx }) => tx);
      this.assertConsistent([...existing, transaction], input);

      this.store.transactions.push({ ...transaction, userId: scope.userId });
      this.write();
      return transaction;
    });
  }

  async updateTransaction(
    scope: DataScope,
    id: string,
    input: TransactionInput,
  ): Promise<Transaction> {
    return this.serialize(scope.userId, async () => {
      this.refresh();
      const row = this.store.transactions.find(
        (candidate) => candidate.id === id && candidate.userId === scope.userId,
      );
      if (!row) throw new Error("İşlem bulunamadı.");

      const updated = { ...row, ...input, updatedAt: this.nowISO() };
      const projected = this.store.transactions
        .filter((candidate) => candidate.userId === scope.userId)
        .map((candidate) => (candidate.id === id ? updated : candidate))
        .map(({ userId: _ignored, ...tx }) => tx);
      this.assertConsistent(projected, input);

      Object.assign(row, updated);
      this.write();
      const { userId: _unused, ...transaction } = updated;
      return transaction;
    });
  }

  async deleteTransaction(scope: DataScope, id: string): Promise<void> {
    return this.serialize(scope.userId, () => {
      this.refresh();

      // Başkasına ait veya olmayan kayıt SESSİZCE başarılı sayılmaz.
      const exists = this.store.transactions.some(
        (row) => row.id === id && row.userId === scope.userId,
      );
      if (!exists) throw new Error("İşlem bulunamadı.");

      const remaining = this.store.transactions
        .filter((row) => row.userId === scope.userId && row.id !== id)
        .map(({ userId: _ignored, ...tx }) => tx);

      // Bir alışın silinmesi sonraki satışları geçersiz kılıyorsa engellenir.
      const negative = findNegativeHolding(remaining);
      if (negative) throw new OversellError(negative.productId, 0);

      this.store.transactions = this.store.transactions.filter(
        (row) => !(row.id === id && row.userId === scope.userId),
      );
      this.write();
    });
  }

  async clearTransactions(scope: DataScope): Promise<void> {
    return this.serialize(scope.userId, () => {
      this.refresh();
      this.store.transactions = this.store.transactions.filter(
        (row) => row.userId !== scope.userId,
      );
      this.write();
    });
  }
}
