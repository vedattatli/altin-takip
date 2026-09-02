import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeUsername } from "@/auth/username";
import { TEST_OVERRIDE_TOKEN } from "@/auth/types";
import type { AdminAuditLog, DeviceMode, UserProfile, UserStatus } from "@/auth/types";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import type {
  AuthBackend,
  CreateUserRequest,
  ResolvedSession,
  SessionRecord,
} from "./backend";

/**
 * YALNIZCA GELİŞTİRME İÇİN yerel kimlik doğrulama arka ucu.
 *
 * Supabase yapılandırması olmadan uygulamayı uçtan uca çalıştırabilmek ve
 * test edebilmek için vardır. Üretim derlemesinde KULLANILAMAZ (aşağıdaki
 * guard hata fırlatır).
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
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  deviceMode: DeviceMode;
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
  return { version: 1, users: [], sessions: [], audit: [], portfolios: [], transactions: [] };
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

function nowISO(): string {
  return new Date().toISOString();
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
  /** Üretim guard'ını testlerde devre dışı bırakmak için değil; yalnızca CLI içindir. */
  allowInProduction?: boolean;
}

export class LocalAuthBackend implements AuthBackend {
  readonly id = "local" as const;
  readonly label = "Yerel geliştirme sunucusu (Supabase değil)";
  readonly syncsAcrossDevices = false;

  private readonly filePath: string | null;
  private store: StoreShape;

  constructor(options: LocalBackendOptions = {}) {
    const testEscapeHatch = process.env.AUTH_ALLOW_LOCAL_BACKEND === TEST_OVERRIDE_TOKEN;
    if (
      process.env.NODE_ENV === "production" &&
      !options.allowInProduction &&
      !testEscapeHatch
    ) {
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
    this.store = this.read();
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
    user.updatedAt = nowISO();
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
    ttlMs: number,
    deviceMode: DeviceMode,
  ): Promise<SessionRecord> {
    this.refresh();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.store.sessions.push({
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      createdAt: nowISO(),
      deviceMode,
    });
    this.write();
    return { token, userId, expiresAt, deviceMode };
  }

  async resolveSession(token: string): Promise<ResolvedSession | null> {
    this.refresh();
    const tokenHash = hashToken(token);
    const session = this.store.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.destroySession(token);
      return null;
    }
    const user = this.store.users.find((candidate) => candidate.id === session.userId);
    if (!user || user.status !== "active") return null;
    return { profile: toProfile(user), deviceMode: session.deviceMode ?? "shared" };
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
          user.username.includes(search) ||
          normalizeUsername(user.displayName).includes(search)
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
    const timestamp = nowISO();
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
    user.updatedAt = nowISO();
    this.write();
    return toProfile(user);
  }

  async setMustChangePassword(userId: string, value: boolean): Promise<UserProfile> {
    this.refresh();
    const user = this.requireUser(userId);
    user.mustChangePassword = value;
    user.updatedAt = nowISO();
    this.write();
    return toProfile(user);
  }

  async recordLogin(userId: string): Promise<void> {
    this.refresh();
    const user = this.requireUser(userId);
    user.lastLoginAt = nowISO();
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
    const row: AdminAuditLog = { ...entry, id: randomUUID(), createdAt: nowISO() };
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

  // --- Portföy ---

  async getPortfolio(userId: string): Promise<PortfolioMeta> {
    this.refresh();
    const existing = this.store.portfolios.find((row) => row.userId === userId);
    if (existing) {
      const { userId: _ignored, ...portfolio } = existing;
      return portfolio;
    }
    const timestamp = nowISO();
    const created: StoredPortfolio = {
      userId,
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
    userId: string,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    await this.getPortfolio(userId);
    const row = this.store.portfolios.find((candidate) => candidate.userId === userId);
    if (!row) throw new Error("Portföy bulunamadı.");
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    row.updatedAt = nowISO();
    this.write();
    const { userId: _ignored, ...portfolio } = row;
    return portfolio;
  }

  async listTransactions(userId: string): Promise<Transaction[]> {
    this.refresh();
    return this.store.transactions
      .filter((row) => row.userId === userId)
      .map(({ userId: _ignored, ...tx }) => tx);
  }

  async createTransaction(userId: string, input: TransactionInput): Promise<Transaction> {
    const portfolio = await this.getPortfolio(userId);
    const timestamp = nowISO();
    const transaction: Transaction = {
      ...input,
      id: randomUUID(),
      portfolioId: portfolio.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.transactions.push({ ...transaction, userId });
    this.write();
    return transaction;
  }

  async updateTransaction(
    userId: string,
    id: string,
    input: TransactionInput,
  ): Promise<Transaction> {
    this.refresh();
    const row = this.store.transactions.find(
      (candidate) => candidate.id === id && candidate.userId === userId,
    );
    if (!row) throw new Error("İşlem bulunamadı.");
    Object.assign(row, input, { updatedAt: nowISO() });
    this.write();
    const { userId: _ignored, ...transaction } = row;
    return transaction;
  }

  async deleteTransaction(userId: string, id: string): Promise<void> {
    this.refresh();
    this.store.transactions = this.store.transactions.filter(
      (row) => !(row.id === id && row.userId === userId),
    );
    this.write();
  }

  async clearTransactions(userId: string): Promise<void> {
    this.refresh();
    this.store.transactions = this.store.transactions.filter((row) => row.userId !== userId);
    this.write();
  }
}
