import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeUsername } from "@/auth/username";
import { TEST_OVERRIDE_TOKEN } from "@/auth/types";
import type {
  AdminAuditLog,
  DeviceMode,
  SessionPolicy,
  UserProfile,
  UserStatus,
} from "@/auth/types";
import { requireProduct } from "@/domain/catalog";
import { findNegativeHolding } from "@/domain/portfolio";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import type { DataScope } from "./actor";
import {
  OversellError,
  type AuthBackend,
  type CreateUserRequest,
  type ResolvedSession,
  type SessionRecord,
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

interface StoredSession {
  id: string;
  tokenHash: string;
  userId: string;
  deviceMode: DeviceMode;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
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

function emptyStore(): StoreShape {
  return { version: 2, users: [], sessions: [], audit: [], portfolios: [], transactions: [] };
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
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreShape;
      return { ...emptyStore(), ...parsed };
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

  // --- Oturum ---

  async createSession(
    userId: string,
    deviceMode: DeviceMode,
    policy: SessionPolicy,
    now: number,
  ): Promise<SessionRecord> {
    this.refresh();
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const idleExpiresAt =
      policy.idleTimeoutMs === null ? null : new Date(now + policy.idleTimeoutMs).toISOString();
    const absoluteExpiresAt = new Date(now + policy.absoluteLifetimeMs).toISOString();
    const timestamp = new Date(now).toISOString();

    this.store.sessions.push({
      id,
      tokenHash: hashToken(token),
      userId,
      deviceMode,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
    });
    this.write();
    return { id, token, userId, deviceMode, idleExpiresAt, absoluteExpiresAt };
  }

  async resolveSession(token: string, now: number): Promise<ResolvedSession | null> {
    this.refresh();
    const tokenHash = hashToken(token);
    const session = this.store.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || session.revokedAt !== null) return null;

    // Hem hareketsizlik hem mutlak süre kontrol edilir.
    const idleExpired = session.idleExpiresAt !== null && Date.parse(session.idleExpiresAt) <= now;
    const absoluteExpired = Date.parse(session.absoluteExpiresAt) <= now;
    if (idleExpired || absoluteExpired) {
      this.store.sessions = this.store.sessions.filter((candidate) => candidate.id !== session.id);
      this.write();
      return null;
    }

    const user = this.store.users.find((candidate) => candidate.id === session.userId);
    if (!user || user.status !== "active") return null;

    return {
      sessionId: session.id,
      profile: toProfile(user),
      deviceMode: session.deviceMode ?? "shared",
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  async touchSession(sessionId: string, idleExpiresAt: string | null, now: number): Promise<void> {
    this.refresh();
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.revokedAt !== null) return;
    session.lastSeenAt = new Date(now).toISOString();
    session.idleExpiresAt = idleExpiresAt;
    this.write();
  }

  async destroySession(token: string): Promise<void> {
    this.refresh();
    const tokenHash = hashToken(token);
    this.store.sessions = this.store.sessions.filter(
      (candidate) => candidate.tokenHash !== tokenHash,
    );
    this.write();
  }

  async destroyAllSessionsForUser(userId: string): Promise<void> {
    this.refresh();
    this.store.sessions = this.store.sessions.filter((candidate) => candidate.userId !== userId);
    this.write();
  }

  async purgeExpiredSessions(now: number): Promise<number> {
    this.refresh();
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter((session) => {
      if (session.revokedAt !== null) return false;
      if (Date.parse(session.absoluteExpiresAt) <= now) return false;
      if (session.idleExpiresAt !== null && Date.parse(session.idleExpiresAt) <= now) return false;
      return true;
    });
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

  async getPortfolio(scope: DataScope): Promise<PortfolioMeta> {
    this.refresh();
    const existing = this.store.portfolios.find((row) => row.userId === scope.userId);
    if (existing) {
      const { userId: _ignored, ...portfolio } = existing;
      return portfolio;
    }
    const timestamp = this.nowISO();
    const created: StoredPortfolio = {
      userId: scope.userId,
      id: randomUUID(),
      name: "Portföyüm",
      displayName: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.portfolios.push(created);
    this.write();
    const { userId: _unused, ...portfolio } = created;
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
