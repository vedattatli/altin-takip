import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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
  requestFingerprint,
  replayProduct,
  resolveLedgerAmounts,
  sortLedgerDesc,
  validatePriceSnapshotInput,
  type LedgerAppendRequest,
  type LedgerEntry,
  type PriceSnapshotRecord,
  type ProductPosition,
} from "@/domain/accounting";
import { GOLD_PRODUCTS, getProduct } from "@/domain/catalog";
import type { PortfolioMeta } from "@/domain/types";
import {
  ProviderNotSelectableError,
  type IngestionPayload,
  type IngestionQuoteInput,
  type IngestionResult,
  type QuarantineRow,
  type ExperimentalAccessRow,
  type MappingApprovalRow,
  type WorkerLeaseState,
  type PricePreferenceResult,
  type PricePreferenceRow,
  type PriceSourceEventRow,
  type ProviderQuotesRow,
  type ProviderStateRow,
  type ProviderSyncInput,
  type StoredQuoteRow,
  ScreenRawRow,
  ScreenRowsSnapshot,
} from "@/server/prices/types";
import type { MfaCredentialRecord } from "./backend";
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
  type LedgerRevision,
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
  /** Bu oturumda ikinci faktörün doğrulandığı an. */
  mfaVerifiedAt?: string | null;
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
  /** Defter sürümü: yalnızca gerçek değişiklikte artar (Supabase portfolios.ledger_revision ikizi). */
  ledgerRevision?: number;
  ledgerUpdatedAt?: string;
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
  /** Fiyat kaynakları (Sprint 3). Supabase tarafındaki tabloların ikizi. */
  priceProviders: StoredPriceProvider[];
  priceQuotes: StoredPriceQuote[];
  priceRuns: StoredPriceRun[];
  pricePreferences: StoredPricePreference[];
  priceSourceEvents: StoredPriceSourceEvent[];
  priceQuarantine: StoredPriceQuarantine[];
  experimentalAccess: StoredExperimentalAccess[];
  mappingApprovals: StoredMappingApproval[];
  workerNonces: { nonce: string; workerId: string; seenAt: string }[];
  workerLeases: StoredWorkerLease[];
  /** Yönetici ikinci faktörü (Sprint 3). Secret ŞİFRELİ; kurtarma kodları özet. */
  mfaCredentials: StoredMfaCredential[];
  mfaRecoveryCodes: StoredRecoveryCode[];
}

interface StoredMfaCredential {
  userId: string;
  secretCiphertext: string;
  secretNonce: string;
  confirmedAt: string | null;
  lastVerifiedAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  /** Başarıyla kullanılan son TOTP zaman adımı; aynı kod tekrar kabul edilmez. */
  lastUsedCounter: number | null;
}

interface StoredRecoveryCode {
  userId: string;
  codeHash: string;
  usedAt: string | null;
}

interface StoredPriceProvider extends ProviderSyncInput {
  enabled: boolean;
  userSelectable: boolean;
  /** Açık global varsayılan (en fazla bir sağlayıcıda true). */
  isDefault: boolean;
  mappingVersion: string;
  mappingCount: number;
  health: ProviderStateRow["health"];
}

/** Deneysel kaynağa portföy bazlı erişim izni. */
interface StoredExperimentalAccess {
  portfolioId: string;
  userId: string;
  providerCode: string;
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: string;
  expiresAt: string | null;
  reason: string;
}

/** Yönetici onaylı ekran eşlemesi. */
interface StoredMappingApproval {
  providerCode: string;
  rawLabel: string;
  canonicalProductId: string;
  confidence: string;
  mappingVersion: string;
  evidenceLiquidation: string | null;
  evidenceReplacement: string | null;
  evidenceObservedAt: string | null;
  approvedBy: string | null;
  approvedAt: string;
  revokedAt: string | null;
}

interface StoredWorkerLease {
  providerCode: string;
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

/** Karantina kaydı: append-only; ham yanıt saklanmaz. */
interface StoredPriceQuarantine {
  id: string;
  ingestionRunId: string;
  providerCode: string;
  marketId: string;
  canonicalProductId: string;
  rejectionCode: string;
  liquidationPrice: string | null;
  replacementPrice: string | null;
  currency: string | null;
  providerTimestamp: string | null;
  fetchedAt: string | null;
  mappingVersion: string | null;
  createdAt: string;
}

interface StoredPriceQuote extends StoredQuoteRow {
  providerCode: string;
  rawPayloadHash: string | null;
  ingestionRunId: string | null;
}

interface StoredPriceRun {
  id: string;
  providerCode: string;
  runKey: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  quoteCount: number;
  rejectedCount: number;
  latencyMs: number | null;
  safeErrorCode: string | null;
}

interface StoredPricePreference {
  userId: string;
  portfolioId: string;
  providerCode: string;
  marketId: string;
  selectedAt: string;
  selectedBy: string | null;
}

interface StoredPriceSourceEvent extends PriceSourceEventRow {
  userId: string;
  portfolioId: string;
}

const STORE_VERSION = 7;

/** Katalogdaki geçerli ürün kimlikleri; bilinmeyen ürün karantinaya alınır. */
const GOLD_PRODUCT_IDS = new Set(GOLD_PRODUCTS.map((product) => product.id));

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
    priceProviders: [],
    priceQuotes: [],
    priceRuns: [],
    pricePreferences: [],
    priceSourceEvents: [],
    priceQuarantine: [],
    experimentalAccess: [],
    mappingApprovals: [],
    workerNonces: [],
    workerLeases: [],
    mfaCredentials: [],
    mfaRecoveryCodes: [],
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
      mfaVerifiedAt: session.mfaVerifiedAt ?? null,
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

  /** Tek kanonik idempotency semantiği (domain/accounting/idempotency.ts) — demo depolarıyla aynı. */
  private static requestHashOf(request: LedgerAppendRequest): string {
    return requestFingerprint(request);
  }

  /** Gerçek değişiklikte defter sürümünü artırır (replay veya başarısız işlemde ÇAĞRILMAZ). */
  private bumpRevision(userId: string): void {
    const portfolio = this.store.portfolios.find((row) => row.userId === userId);
    if (!portfolio) return;
    portfolio.ledgerRevision = (portfolio.ledgerRevision ?? 0) + 1;
    portfolio.ledgerUpdatedAt = this.nowISO();
  }

  async getLedgerRevision(scope: DataScope): Promise<LedgerRevision> {
    this.refresh();
    const portfolio = this.store.portfolios.find((row) => row.userId === scope.userId);
    if (!portfolio) throw new PortfolioNotProvisionedError(scope.userId);
    return {
      revision: portfolio.ledgerRevision ?? 0,
      updatedAt: portfolio.ledgerUpdatedAt ?? portfolio.updatedAt,
    };
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
      this.bumpRevision(scope.userId);
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
      this.bumpRevision(scope.userId);
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
          // Replay yanıtı ilk yanıtla AYNI biçimdedir: [eski ürün pozisyonu, (farklıysa) yeni ürün pozisyonu].
          const replayed = this.replayResult(scope.userId, request)!;
          const ledger = this.userLedger(scope.userId);
          const positions = [this.positionOf(ledger, row.productId)];
          if (existing.productId !== row.productId) positions.push(this.positionOf(ledger, existing.productId));
          return { voided: stripStored(row), entry: replayed.entry, positions };
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
      this.bumpRevision(scope.userId);
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
      if (count > 0) {
        this.bumpRevision(scope.userId);
        this.write();
      }
      return count;
    });
  }

  async verifyLedger(scope: DataScope): Promise<LedgerVerifyResult> {
    this.refresh();
    // Yerel arka uçta pozisyon her zaman defterden türetilir; ayrı projeksiyon yoktur.
    const positions = replayLedger(this.userLedger(scope.userId));
    return { checked: positions.size, mismatches: [] };
  }

  // --- Fiyat kaynakları (Sprint 3) ---
  // Supabase RPC'leriyle AYNI kuralları uygular: lisanssız kaynak etkinleştirilemez,
  // kullanıcı yalnızca allowlist'teki kaynağı seçebilir, kaynak değişimi olay üretir,
  // aynı koşum anahtarı iki kez uygulanmaz.

  private providerRow(code: string): StoredPriceProvider | undefined {
    return this.store.priceProviders.find((provider) => provider.code === code);
  }

  private toProviderState(provider: StoredPriceProvider): ProviderStateRow {
    const runs = this.store.priceRuns
      .filter((run) => run.providerCode === provider.code)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const lastRun = runs[0];
    return {
      code: provider.code,
      displayName: provider.displayName,
      technicalName: provider.technicalName,
      marketId: provider.marketId,
      marketDisplayName: provider.marketDisplayName,
      providerType: provider.providerType,
      enabled: provider.enabled,
      userSelectable: provider.userSelectable,
      isDefault: provider.isDefault === true,
      licenseStatus: provider.licenseStatus,
      licenseReference: provider.licenseReference,
      redistributionAllowed: provider.redistributionAllowed,
      capabilities: [...provider.capabilities],
      attribution: provider.attribution,
      referenceUrl: provider.referenceUrl,
      coverage: this.store.priceQuotes.filter((quote) => quote.providerCode === provider.code).length,
      mappingCount: provider.mappingCount,
      health: provider.health,
      lastRun: lastRun
        ? {
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            completedAt: lastRun.completedAt,
            quoteCount: lastRun.quoteCount,
            rejectedCount: lastRun.rejectedCount,
            latencyMs: lastRun.latencyMs,
            safeErrorCode: lastRun.safeErrorCode,
          }
        : null,
    };
  }

  async syncPriceProviders(providers: readonly ProviderSyncInput[]): Promise<number> {
    this.refresh();
    for (const input of providers) {
      const existing = this.providerRow(input.code);
      // Deneysel kaynak da etkin kalabilir; lisanslı SAYILMAZ ama kapatılmaz.
      const licensed =
        input.licenseStatus === "LICENSED" ||
        input.licenseStatus === "DEV_ONLY" ||
        input.licenseStatus === "EXPERIMENTAL_PRIVATE";
      if (existing) {
        const wasDefault = existing.isDefault === true;
        Object.assign(existing, input);
        // Lisans kaybedilirse kaynak otomatik olarak kapanır (fail closed).
        existing.enabled = existing.enabled && licensed;
        existing.userSelectable = existing.userSelectable && existing.enabled;
        // Kapanan kaynak global varsayılan olarak da kalamaz.
        existing.isDefault = wasDefault && existing.enabled && existing.userSelectable;
      } else {
        this.store.priceProviders.push({
          ...input,
          enabled: false,
          userSelectable: false,
          isDefault: false,
          mappingVersion: "none",
          mappingCount: 0,
          health: null,
        });
      }
    }
    this.write();
    return providers.length;
  }

  async syncPriceMappings(code: string, mappingVersion: string, mapping: Record<string, string>): Promise<number> {
    this.refresh();
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);
    provider.mappingVersion = mappingVersion;
    provider.mappingCount = Object.keys(mapping).length;
    this.write();
    return provider.mappingCount;
  }

  async listPriceProviders(): Promise<ProviderStateRow[]> {
    this.refresh();
    return this.store.priceProviders
      .map((provider) => this.toProviderState(provider))
      .sort((a, b) => (a.marketId === b.marketId ? a.code.localeCompare(b.code) : a.marketId.localeCompare(b.marketId)));
  }

  async setPriceProviderFlags(code: string, enabled: boolean, userSelectable: boolean): Promise<ProviderStateRow> {
    this.refresh();
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);
    // Sunucudaki kısıtla aynı: deneysel kaynak da etkinleştirilebilir ama
    // LİSANSLI SAYILMAZ ve "kullanıcıya açık" listesine giremez.
    const activatable = ["LICENSED", "DEV_ONLY", "EXPERIMENTAL_PRIVATE"];
    if (enabled && !activatable.includes(provider.licenseStatus)) {
      throw new ProviderNotSelectableError(code, "Bu kaynak lisans/izin olmadan etkinleştirilemez.");
    }
    if (userSelectable && provider.licenseStatus === "EXPERIMENTAL_PRIVATE") {
      throw new ProviderNotSelectableError(
        code,
        "Deneysel kaynak genel listeye açılamaz; erişim portföy bazlı izin listesiyle verilir.",
      );
    }
    if (enabled && provider.licenseStatus === "LICENSED" && !provider.redistributionAllowed) {
      throw new ProviderNotSelectableError(code, "Bu kaynak için yeniden gösterim izni işaretlenmemiş.");
    }
    if (userSelectable && !enabled) {
      throw new ProviderNotSelectableError(code, "Kapalı bir kaynak kullanıcıya sunulamaz.");
    }
    provider.enabled = enabled;
    provider.userSelectable = userSelectable;
    // Kapatılan veya kullanıcıya kapatılan kaynak varsayılan olamaz.
    if (!provider.enabled || !provider.userSelectable) provider.isDefault = false;
    this.write();
    return this.toProviderState(provider);
  }

  private screenRowsStore = new Map<string, ScreenRowsSnapshot>();

  async setScreenRows(
    code: string,
    rows: readonly ScreenRawRow[],
    signature: string,
    observedAt: string,
  ): Promise<void> {
    this.screenRowsStore.set(code, {
      rows: [...rows],
      screenSignature: signature,
      observedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async screenRows(code: string): Promise<ScreenRowsSnapshot | null> {
    return this.screenRowsStore.get(code) ?? null;
  }

  async applyPriceIngestion(code: string, runKey: string, payload: IngestionPayload): Promise<IngestionResult> {
    this.refresh();
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);

    const existing = this.store.priceRuns.find((run) => run.runKey === runKey);
    if (existing) {
      return {
        runId: existing.id,
        status: existing.status,
        skipped: true,
        quoteCount: existing.quoteCount,
        rejectedCount: existing.rejectedCount,
        replayed: true,
      };
    }

    // Sunucu RPC'siyle AYNI kurallar: kapalı/lisanssız/referans kaynak yazamaz.
    if (!provider.enabled) {
      throw new ProviderNotSelectableError(code, "Kapalı sağlayıcı fiyat yazamaz.");
    }
    if (provider.licenseStatus !== "LICENSED" && provider.licenseStatus !== "DEV_ONLY") {
      throw new ProviderNotSelectableError(code, "Lisanssız sağlayıcı fiyat yazamaz.");
    }
    if (provider.licenseStatus === "LICENSED" && !provider.redistributionAllowed) {
      throw new ProviderNotSelectableError(code, "Yeniden gösterim izni olmayan sağlayıcı fiyat yazamaz.");
    }
    if (provider.capabilities.includes("REFERENCE_ONLY")) {
      throw new ProviderNotSelectableError(code, "Referans kaynağı değerleme fiyatı yazamaz.");
    }

    const runId = randomUUID();
    const startedAt = this.nowISO();
    let staleCount = 0;

    const quarantine = (entry: {
      canonicalProductId: string;
      code: string;
      liquidationPrice?: string | null;
      replacementPrice?: string | null;
      currency?: string | null;
      providerTimestamp?: string | null;
      fetchedAt?: string | null;
      mappingVersion?: string | null;
    }) => {
      this.store.priceQuarantine.push({
        id: randomUUID(),
        ingestionRunId: runId,
        providerCode: code,
        marketId: provider.marketId,
        canonicalProductId: entry.canonicalProductId,
        rejectionCode: entry.code,
        liquidationPrice: entry.liquidationPrice ?? null,
        replacementPrice: entry.replacementPrice ?? null,
        currency: entry.currency ?? null,
        providerTimestamp: entry.providerTimestamp ?? null,
        fetchedAt: entry.fetchedAt ?? null,
        mappingVersion: entry.mappingVersion ?? null,
        createdAt: this.nowISO(),
      });
    };

    for (const entry of payload.quarantined) quarantine(entry);

    const seen = new Set<string>();
    const accepted: IngestionQuoteInput[] = [];
    for (const quote of payload.quotes) {
      const liquidation = Number(quote.liquidationPrice);
      const replacement = Number(quote.replacementPrice);
      const providerTs = Date.parse(quote.providerTimestamp ?? "");
      let reject: string | null = null;
      if (!GOLD_PRODUCT_IDS.has(quote.canonicalProductId)) reject = "PRODUCT_UNKNOWN";
      else if (seen.has(quote.canonicalProductId)) reject = "DUPLICATE_CANONICAL_PRODUCT";
      else if (!Number.isFinite(liquidation) || !Number.isFinite(replacement) || liquidation <= 0 || replacement <= 0)
        reject = "PRICE_NOT_POSITIVE";
      else if (replacement < liquidation) reject = "INVERTED_SPREAD";
      else if (!Number.isFinite(providerTs)) reject = "TIMESTAMP_INVALID";
      else if (providerTs > Date.parse(this.nowISO()) + 5 * 60_000) reject = "TIMESTAMP_FUTURE";

      if (reject) {
        quarantine({
          canonicalProductId: quote.canonicalProductId,
          code: reject,
          liquidationPrice: quote.liquidationPrice,
          replacementPrice: quote.replacementPrice,
          currency: "TRY",
          providerTimestamp: quote.providerTimestamp,
          fetchedAt: quote.fetchedAt,
          mappingVersion: quote.mappingVersion,
        });
        continue;
      }
      seen.add(quote.canonicalProductId);
      accepted.push(quote);
    }

    for (const quote of accepted) {
      const row: StoredPriceQuote = {
        providerCode: code,
        canonicalProductId: quote.canonicalProductId,
        marketId: provider.marketId,
        liquidationPrice: quote.liquidationPrice,
        replacementPrice: quote.replacementPrice,
        currency: "TRY",
        upstreamSourceId: quote.upstreamSourceId,
        // Buraya yalnızca kalite kapısından geçmiş kayıtlar gelir; zamanı olmayan
        // kayıt daha önce karantinaya alınmıştır.
        providerTimestamp: quote.providerTimestamp ?? "",
        fetchedAt: quote.fetchedAt,
        status: quote.status,
        mappingVersion: quote.mappingVersion,
        rawPayloadHash: quote.rawPayloadHash,
        ingestionRunId: runId,
      };
      if (quote.status === "stale") staleCount += 1;
      const index = this.store.priceQuotes.findIndex(
        (candidate) => candidate.providerCode === code && candidate.canonicalProductId === quote.canonicalProductId,
      );
      if (index >= 0) this.store.priceQuotes[index] = row;
      else this.store.priceQuotes.push(row);
    }

    const rejected = this.store.priceQuarantine.filter((row) => row.ingestionRunId === runId).length;
    const status =
      payload.status === "unavailable" || accepted.length === 0
        ? "FAILED"
        : payload.status === "partial" || rejected > 0
          ? "PARTIAL"
          : "SUCCESS";
    this.store.priceRuns.push({
      id: runId,
      providerCode: code,
      runKey,
      status,
      startedAt,
      completedAt: this.nowISO(),
      quoteCount: accepted.length,
      rejectedCount: rejected,
      latencyMs: payload.latencyMs,
      safeErrorCode: payload.safeErrorCode,
    });
    provider.health = {
      status: accepted.length > 0 && rejected === 0 ? "ok" : accepted.length > 0 ? "degraded" : "unavailable",
      lastSuccessAt: accepted.length > 0 ? this.nowISO() : (provider.health?.lastSuccessAt ?? null),
      lastErrorAt: accepted.length === 0 || rejected > 0 ? this.nowISO() : (provider.health?.lastErrorAt ?? null),
      coverageCount: accepted.length,
      staleCount,
      quarantinedCount: rejected,
      latencyMs: payload.latencyMs,
      safeErrorCode: payload.safeErrorCode,
    };
    this.write();
    return {
      runId,
      status,
      skipped: false,
      quoteCount: accepted.length,
      rejectedCount: rejected,
      replayed: false,
    };
  }

  async listPriceQuarantine(code: string | null, limit = 50): Promise<QuarantineRow[]> {
    this.refresh();
    const capped = Math.max(1, Math.min(limit, 200));
    return this.store.priceQuarantine
      .filter((row) => (code === null ? true : row.providerCode === code))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, capped)
      .map((row) => ({
        providerCode: row.providerCode,
        marketId: row.marketId,
        canonicalProductId: row.canonicalProductId,
        rejectionCode: row.rejectionCode,
        liquidationPrice: row.liquidationPrice,
        replacementPrice: row.replacementPrice,
        currency: row.currency,
        providerTimestamp: row.providerTimestamp,
        fetchedAt: row.fetchedAt,
        mappingVersion: row.mappingVersion,
        createdAt: row.createdAt,
      }));
  }

  async setDefaultPriceProvider(code: string | null): Promise<string | null> {
    this.refresh();
    if (code === null) {
      for (const provider of this.store.priceProviders) provider.isDefault = false;
      this.write();
      return null;
    }
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);
    if (!provider.enabled || !provider.userSelectable) {
      throw new ProviderNotSelectableError(code, "Kapalı bir kaynak varsayılan yapılamaz.");
    }
    if (provider.capabilities.includes("REFERENCE_ONLY")) {
      throw new ProviderNotSelectableError(code, "Referans kaynağı varsayılan yapılamaz.");
    }
    // Deneysel kaynak hiçbir koşulda global varsayılan olamaz.
    if (provider.licenseStatus === "EXPERIMENTAL_PRIVATE") {
      throw new ProviderNotSelectableError(code, "Deneysel kaynak global varsayılan yapılamaz.");
    }
    for (const candidate of this.store.priceProviders) candidate.isDefault = candidate.code === code;
    this.write();
    return code;
  }

  async defaultPriceProvider(): Promise<string | null> {
    this.refresh();
    return this.store.priceProviders.find((provider) => provider.isDefault)?.code ?? null;
  }

  // --- Deneysel özel pilot (Sprint 3.2) ---

  async setExperimentalAccess(
    userId: string,
    code: string,
    enabled: boolean,
    adminId: string,
    reason: string,
    expiresAt: string | null,
  ): Promise<void> {
    this.refresh();
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);
    if (provider.licenseStatus !== "EXPERIMENTAL_PRIVATE") {
      throw new ProviderNotSelectableError(code, "Bu kaynak deneysel değildir; izin listesi kullanılamaz.");
    }
    const portfolio = this.store.portfolios.find((row) => row.userId === userId);
    if (!portfolio) throw new Error("Portföy bulunamadı");
    const existing = this.store.experimentalAccess.find(
      (row) => row.portfolioId === portfolio.id && row.providerCode === code,
    );
    if (existing) {
      existing.enabled = enabled;
      existing.approvedBy = adminId;
      existing.approvedAt = this.nowISO();
      existing.expiresAt = expiresAt;
      existing.reason = reason;
    } else {
      this.store.experimentalAccess.push({
        portfolioId: portfolio.id,
        userId,
        providerCode: code,
        enabled,
        approvedBy: adminId,
        approvedAt: this.nowISO(),
        expiresAt,
        reason,
      });
    }
    this.write();
  }

  async experimentalAccessAllowed(userId: string, code: string): Promise<boolean> {
    this.refresh();
    const row = this.store.experimentalAccess.find(
      (candidate) => candidate.userId === userId && candidate.providerCode === code,
    );
    if (!row || !row.enabled) return false;
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(this.nowISO())) return false;
    return true;
  }

  async listExperimentalAccess(code: string): Promise<ExperimentalAccessRow[]> {
    this.refresh();
    return this.store.experimentalAccess
      .filter((row) => row.providerCode === code)
      .map((row) => {
        const user = this.store.users.find((candidate) => candidate.id === row.userId);
        return {
          username: user?.username ?? "(bilinmiyor)",
          displayName: user?.displayName ?? "",
          portfolioId: row.portfolioId,
          enabled: row.enabled,
          approvedAt: row.approvedAt,
          expiresAt: row.expiresAt,
          reason: row.reason,
        };
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async approvePriceMapping(input: {
    code: string;
    rawLabel: string;
    canonicalProductId: string;
    mappingVersion: string;
    adminId: string;
    evidenceLiquidation: string | null;
    evidenceReplacement: string | null;
    evidenceObservedAt: string | null;
    revoke: boolean;
  }): Promise<void> {
    this.refresh();
    if (!this.providerRow(input.code)) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${input.code}`);
    if (!GOLD_PRODUCT_IDS.has(input.canonicalProductId)) {
      throw new Error(`Bilinmeyen ürün: ${input.canonicalProductId}`);
    }
    const existing = this.store.mappingApprovals.find(
      (row) =>
        row.providerCode === input.code &&
        row.rawLabel === input.rawLabel &&
        row.mappingVersion === input.mappingVersion,
    );
    if (input.revoke) {
      if (existing) existing.revokedAt = this.nowISO();
      this.write();
      return;
    }
    if (existing) {
      existing.canonicalProductId = input.canonicalProductId;
      existing.evidenceLiquidation = input.evidenceLiquidation;
      existing.evidenceReplacement = input.evidenceReplacement;
      existing.evidenceObservedAt = input.evidenceObservedAt;
      existing.approvedBy = input.adminId;
      existing.approvedAt = this.nowISO();
      existing.revokedAt = null;
    } else {
      this.store.mappingApprovals.push({
        providerCode: input.code,
        rawLabel: input.rawLabel,
        canonicalProductId: input.canonicalProductId,
        confidence: "OPERATOR_VERIFIED",
        mappingVersion: input.mappingVersion,
        evidenceLiquidation: input.evidenceLiquidation,
        evidenceReplacement: input.evidenceReplacement,
        evidenceObservedAt: input.evidenceObservedAt,
        approvedBy: input.adminId,
        approvedAt: this.nowISO(),
        revokedAt: null,
      });
    }
    this.write();
  }

  async listMappingApprovals(code: string): Promise<MappingApprovalRow[]> {
    this.refresh();
    return this.store.mappingApprovals
      .filter((row) => row.providerCode === code && row.revokedAt === null)
      .map((row) => ({
        rawLabel: row.rawLabel,
        canonicalProductId: row.canonicalProductId,
        confidence: row.confidence,
        mappingVersion: row.mappingVersion,
        evidenceLiquidation: row.evidenceLiquidation,
        evidenceReplacement: row.evidenceReplacement,
        evidenceObservedAt: row.evidenceObservedAt,
        approvedBy: this.store.users.find((user) => user.id === row.approvedBy)?.username ?? null,
        approvedAt: row.approvedAt,
      }))
      .sort((a, b) => a.rawLabel.localeCompare(b.rawLabel));
  }

  async claimWorkerNonce(nonce: string, workerId: string): Promise<boolean> {
    // Sunucudaki benzersiz anahtar kısıtıyla aynı garanti: aynı nonce iki kez
    // kabul edilmez. Yazma kuyruğu eşzamanlı çağrıları sıraya sokar.
    return this.serialize(`worker-nonce`, () => {
      this.refresh();
      const cutoff = Date.parse(this.nowISO()) - 60 * 60_000;
      this.store.workerNonces = this.store.workerNonces.filter((row) => Date.parse(row.seenAt) >= cutoff);
      if (this.store.workerNonces.some((row) => row.nonce === nonce)) return false;
      this.store.workerNonces.push({ nonce, workerId, seenAt: this.nowISO() });
      this.write();
      return true;
    });
  }

  async acquireWorkerLease(
    code: string,
    workerId: string,
    ttlSeconds: number,
  ): Promise<{ held: boolean; workerId: string; takeover: boolean }> {
    return this.serialize(`worker-lease:${code}`, () => {
      this.refresh();
      const now = Date.parse(this.nowISO());
      const ttl = Math.max(30, ttlSeconds) * 1000;
      const existing = this.store.workerLeases.find((row) => row.providerCode === code);
      if (!existing) {
        this.store.workerLeases.push({
          providerCode: code,
          workerId,
          acquiredAt: this.nowISO(),
          heartbeatAt: this.nowISO(),
          expiresAt: new Date(now + ttl).toISOString(),
        });
        this.write();
        return { held: true, workerId, takeover: false };
      }
      if (existing.workerId === workerId) {
        existing.heartbeatAt = this.nowISO();
        existing.expiresAt = new Date(now + ttl).toISOString();
        this.write();
        return { held: true, workerId, takeover: false };
      }
      if (Date.parse(existing.expiresAt) > now) {
        return { held: false, workerId: existing.workerId, takeover: false };
      }
      existing.workerId = workerId;
      existing.acquiredAt = this.nowISO();
      existing.heartbeatAt = this.nowISO();
      existing.expiresAt = new Date(now + ttl).toISOString();
      this.write();
      return { held: true, workerId, takeover: true };
    });
  }

  async workerLeaseState(code: string): Promise<WorkerLeaseState | null> {
    this.refresh();
    const row = this.store.workerLeases.find((candidate) => candidate.providerCode === code);
    if (!row) return null;
    return {
      workerId: row.workerId,
      acquiredAt: row.acquiredAt,
      heartbeatAt: row.heartbeatAt,
      expiresAt: row.expiresAt,
      active: Date.parse(row.expiresAt) > Date.parse(this.nowISO()),
    };
  }

  async currentPriceQuotes(code: string): Promise<ProviderQuotesRow | null> {
    this.refresh();
    const provider = this.providerRow(code);
    if (!provider) return null;
    return {
      providerCode: provider.code,
      marketId: provider.marketId,
      displayName: provider.displayName,
      technicalName: provider.technicalName,
      marketDisplayName: provider.marketDisplayName,
      licenseStatus: provider.licenseStatus,
      enabled: provider.enabled,
      userSelectable: provider.userSelectable,
      attribution: provider.attribution,
      health: provider.health,
      quotes: this.store.priceQuotes
        .filter((quote) => quote.providerCode === code && quote.status === "ok")
        .map(({ providerCode: _code, rawPayloadHash: _hash, ingestionRunId: _run, ...quote }) => quote)
        .sort((a, b) => a.canonicalProductId.localeCompare(b.canonicalProductId)),
    };
  }

  async comparePriceQuotes(codes: readonly string[]): Promise<ProviderQuotesRow[]> {
    const rows: ProviderQuotesRow[] = [];
    for (const code of codes) {
      const row = await this.currentPriceQuotes(code);
      if (row) rows.push(row);
    }
    return rows;
  }

  async getPricePreference(scope: DataScope): Promise<PricePreferenceRow> {
    this.refresh();
    const preference = this.store.pricePreferences.find((row) => row.userId === scope.userId);
    if (!preference) {
      const portfolio = this.store.portfolios.find((row) => row.userId === scope.userId);
      return {
        portfolioId: portfolio?.id ?? null,
        providerCode: null,
        marketId: null,
        selectedAt: null,
        selectedBy: null,
      };
    }
    return {
      portfolioId: preference.portfolioId,
      providerCode: preference.providerCode,
      marketId: preference.marketId,
      selectedAt: preference.selectedAt,
      selectedBy: preference.selectedBy,
    };
  }

  async setPricePreference(
    scope: DataScope,
    code: string,
    actorId: string,
    role: "user" | "admin",
    reason: string,
  ): Promise<PricePreferenceResult> {
    this.refresh();
    const portfolio = this.store.portfolios.find((row) => row.userId === scope.userId);
    if (!portfolio) throw new PortfolioNotProvisionedError(scope.userId);
    const provider = this.providerRow(code);
    if (!provider) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${code}`);
    if (!provider.enabled) {
      throw new ProviderNotSelectableError(code, "Bu kaynak kullanıma kapalı.");
    }
    if (role === "user" && !provider.userSelectable) {
      // Deneysel kaynak genel listeye açılmaz; erişim portföy bazlı izin
      // listesiyle verilir ve BURADA da doğrulanır (arayüz kontrolü yetmez).
      const experimentalAllowed =
        provider.licenseStatus === "EXPERIMENTAL_PRIVATE" &&
        this.store.experimentalAccess.some(
          (row) =>
            row.userId === scope.userId &&
            row.providerCode === code &&
            row.enabled &&
            (row.expiresAt === null || Date.parse(row.expiresAt) > Date.parse(this.nowISO())),
        );
      if (!experimentalAllowed) {
        throw new ProviderNotSelectableError(code, "Bu kaynak kullanıcı seçimine kapalı.");
      }
    }
    if (provider.capabilities.includes("REFERENCE_ONLY")) {
      throw new ProviderNotSelectableError(code, "Referans kaynağı değerleme için seçilemez.");
    }

    const existing = this.store.pricePreferences.find((row) => row.userId === scope.userId);
    const previousCode = existing?.providerCode ?? null;
    const previousMarket = existing?.marketId ?? null;
    const timestamp = this.nowISO();
    if (existing) {
      existing.providerCode = provider.code;
      existing.marketId = provider.marketId;
      existing.selectedAt = timestamp;
      existing.selectedBy = actorId;
    } else {
      this.store.pricePreferences.push({
        userId: scope.userId,
        portfolioId: portfolio.id,
        providerCode: provider.code,
        marketId: provider.marketId,
        selectedAt: timestamp,
        selectedBy: actorId,
      });
    }

    const changed = previousCode !== provider.code;
    if (changed) {
      this.store.priceSourceEvents.push({
        userId: scope.userId,
        portfolioId: portfolio.id,
        changedAt: timestamp,
        previousProviderCode: previousCode,
        newProviderCode: provider.code,
        previousMarketId: previousMarket,
        newMarketId: provider.marketId,
        changedByRole: role,
        reason: reason.slice(0, 200),
      });
    }
    this.write();
    return {
      portfolioId: portfolio.id,
      providerCode: provider.code,
      marketId: provider.marketId,
      previousProviderCode: previousCode,
      changed,
    };
  }

  async listPriceSourceEvents(scope: DataScope, limit = 50): Promise<PriceSourceEventRow[]> {
    this.refresh();
    return this.store.priceSourceEvents
      .filter((event) => event.userId === scope.userId)
      .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
      .slice(0, Math.max(limit, 1))
      .map(({ userId: _user, portfolioId: _portfolio, ...event }) => event);
  }

  // --- Yönetici ikinci faktörü (Sprint 3) ---

  async getMfaCredential(userId: string): Promise<MfaCredentialRecord | null> {
    this.refresh();
    const row = this.store.mfaCredentials.find((credential) => credential.userId === userId);
    return row ? { ...row } : null;
  }

  async saveMfaCredential(userId: string, secret: { ciphertext: string; nonce: string }): Promise<void> {
    this.refresh();
    const existing = this.store.mfaCredentials.find((credential) => credential.userId === userId);
    const record: StoredMfaCredential = {
      userId,
      secretCiphertext: secret.ciphertext,
      secretNonce: secret.nonce,
      confirmedAt: null,
      lastVerifiedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
      lastUsedCounter: null,
    };
    if (existing) Object.assign(existing, record);
    else this.store.mfaCredentials.push(record);
    this.write();
  }

  async confirmMfaCredential(userId: string, at: string): Promise<void> {
    this.refresh();
    const row = this.store.mfaCredentials.find((credential) => credential.userId === userId);
    if (!row) return;
    row.confirmedAt = at;
    row.lastVerifiedAt = at;
    row.failedAttempts = 0;
    row.lockedUntil = null;
    this.write();
  }

  async deleteMfaCredential(userId: string): Promise<void> {
    this.refresh();
    this.store.mfaCredentials = this.store.mfaCredentials.filter((row) => row.userId !== userId);
    this.store.mfaRecoveryCodes = this.store.mfaRecoveryCodes.filter((row) => row.userId !== userId);
    this.write();
  }

  async recordMfaAttempt(userId: string, success: boolean, at: string): Promise<MfaCredentialRecord | null> {
    this.refresh();
    const row = this.store.mfaCredentials.find((credential) => credential.userId === userId);
    if (!row) return null;
    row.failedAttempts = success ? 0 : row.failedAttempts + 1;
    // Art arda 5 hatalı denemede 15 dakika kilit.
    row.lockedUntil = !success && row.failedAttempts >= 5 ? new Date(Date.parse(at) + 15 * 60_000).toISOString() : null;
    if (success) row.lastVerifiedAt = at;
    this.write();
    return { ...row };
  }

  async claimMfaCounter(userId: string, counter: number): Promise<boolean> {
    // Yerel arka uçta yazma işlemleri kullanıcı başına sıraya alınır; bu yüzden
    // oku-karşılaştır-yaz dizisi sunucudaki atomik UPDATE ile aynı garantiyi verir.
    return this.serialize(userId, () => {
      this.refresh();
      const row = this.store.mfaCredentials.find((credential) => credential.userId === userId);
      if (!row) return false;
      if (row.lastUsedCounter !== null && counter <= row.lastUsedCounter) return false;
      row.lastUsedCounter = counter;
      this.write();
      return true;
    });
  }

  async replaceRecoveryCodes(userId: string, hashes: readonly string[]): Promise<void> {
    this.refresh();
    this.store.mfaRecoveryCodes = this.store.mfaRecoveryCodes.filter((row) => row.userId !== userId);
    for (const hash of hashes) {
      this.store.mfaRecoveryCodes.push({ userId, codeHash: hash, usedAt: null });
    }
    this.write();
  }

  async consumeRecoveryCode(userId: string, hash: string, at: string): Promise<boolean> {
    this.refresh();
    const row = this.store.mfaRecoveryCodes.find(
      (candidate) => candidate.userId === userId && candidate.codeHash === hash && candidate.usedAt === null,
    );
    if (!row) return false;
    row.usedAt = at;
    this.write();
    return true;
  }

  async countRecoveryCodes(userId: string): Promise<number> {
    this.refresh();
    return this.store.mfaRecoveryCodes.filter((row) => row.userId === userId && row.usedAt === null).length;
  }

  async markSessionMfaVerified(sessionId: string, at: string): Promise<void> {
    this.refresh();
    const session = this.store.sessions.find((row) => row.id === sessionId);
    if (!session) return;
    session.mfaVerifiedAt = at;
    this.write();
  }
}

function stripStored(row: StoredLedgerEntry): LedgerEntry {
  const { userId: _ignored, requestHash: _hash, ...entry } = row;
  return entry;
}
