import type { AdminAuditLog, DeviceMode, UserProfile, UserRole, UserStatus } from "@/auth/types";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";

/**
 * Kimlik doğrulama + veri arka ucu sözleşmesi.
 *
 * İki uygulaması vardır:
 *  - SupabaseAuthBackend : üretim. Parolalar Supabase Auth'ta tutulur.
 *  - LocalAuthBackend    : YALNIZCA geliştirme. Üretim derlemesinde çalışmaz.
 *
 * Yetkilendirme, denetim kaydı (audit) ve iş kuralları burada DEĞİL,
 * AuthService içinde uygulanır; böylece tek bir yerden test edilebilir.
 */

export interface CreateUserRequest {
  username: string;
  displayName: string;
  temporaryPassword: string;
  role: UserRole;
}

export interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: string;
  deviceMode: DeviceMode;
}

/** Çözülmüş oturum: profil + oturumun açıldığı cihaz türü. */
export interface ResolvedSession {
  profile: UserProfile;
  deviceMode: DeviceMode;
}

export interface AuthBackend {
  readonly id: "supabase" | "local";
  readonly label: string;
  /** Veriler sunucuda kalıcı mı ve cihazlar arasında paylaşılıyor mu? */
  readonly syncsAcrossDevices: boolean;

  /** Arka ucun kullanılabilir olduğunu doğrular; değilse Türkçe hata fırlatır. */
  ensureReady(): Promise<void>;

  // --- Kimlik doğrulama ---
  /** Parolayı doğrular. Kullanıcı yoksa da parola yanlışsa da null döner. */
  verifyCredentials(username: string, password: string): Promise<UserProfile | null>;
  /** Kullanıcının mevcut parolasını doğrular (parola değiştirme akışı için). */
  verifyPasswordForUser(userId: string, password: string): Promise<boolean>;
  setPassword(userId: string, newPassword: string): Promise<void>;

  // --- Oturum ---
  createSession(userId: string, ttlMs: number, deviceMode: DeviceMode): Promise<SessionRecord>;
  resolveSession(token: string): Promise<ResolvedSession | null>;
  destroySession(token: string): Promise<void>;
  /** Parola sıfırlama / pasifleştirme sonrası tüm cihazlardaki oturumları düşürür. */
  destroyAllSessionsForUser(userId: string): Promise<void>;

  // --- Profiller ---
  getProfile(userId: string): Promise<UserProfile | null>;
  findProfileByUsername(username: string): Promise<UserProfile | null>;
  listProfiles(options?: { search?: string; limit?: number }): Promise<UserProfile[]>;
  countAdmins(): Promise<number>;
  createUser(request: CreateUserRequest): Promise<UserProfile>;
  setStatus(userId: string, status: UserStatus): Promise<UserProfile>;
  setMustChangePassword(userId: string, value: boolean): Promise<UserProfile>;
  recordLogin(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // --- Denetim kaydı ---
  appendAudit(entry: Omit<AdminAuditLog, "id" | "createdAt">): Promise<AdminAuditLog>;
  listAudit(limit?: number): Promise<AdminAuditLog[]>;

  // --- Portföy verisi (kullanıcıya ait) ---
  getPortfolio(userId: string): Promise<PortfolioMeta>;
  updatePortfolio(
    userId: string,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta>;
  listTransactions(userId: string): Promise<Transaction[]>;
  createTransaction(userId: string, input: TransactionInput): Promise<Transaction>;
  updateTransaction(userId: string, id: string, input: TransactionInput): Promise<Transaction>;
  deleteTransaction(userId: string, id: string): Promise<void>;
  clearTransactions(userId: string): Promise<void>;
}
