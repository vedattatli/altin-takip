import type {
  AdminAuditLog,
  DeviceMode,
  SessionPolicy,
  UserProfile,
  UserRole,
  UserStatus,
} from "@/auth/types";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import type { DataScope } from "./actor";

/**
 * Kimlik doğrulama + veri arka ucu sözleşmesi.
 *
 * İki uygulaması vardır:
 *  - SupabaseAuthBackend : üretim. Parolalar Supabase Auth'ta tutulur.
 *  - LocalAuthBackend    : YALNIZCA geliştirme/test. Üretim derlemesinde çalışmaz.
 *
 * YETKİLENDİRME SINIRI
 * Kullanıcıya ait veri metotları ham `userId: string` DEĞİL, markalanmış
 * `DataScope` alır. `DataScope` yalnızca `ownScope()` (kendi verisi) veya
 * `adminScope()` (yönetici, hedef kullanıcı) ile üretilebilir. Böylece bir
 * route gövdeden gelen kimlikle veri metodunu çağıramaz — bu derleme hatasıdır.
 *
 * Yetkilendirme, denetim kaydı ve iş kuralları arka uçta DEĞİL, servis
 * katmanında (AuthService / AdminService / UserPortfolioService) uygulanır.
 */

export interface CreateUserRequest {
  username: string;
  displayName: string;
  temporaryPassword: string;
  role: UserRole;
}

export interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  deviceMode: DeviceMode;
  /** Hareketsizlik son kullanma zamanı (ISO). null ise hareketsizlik sınırı yok. */
  idleExpiresAt: string | null;
  /** Mutlak son kullanma zamanı (ISO). Her cihaz türünde doludur. */
  absoluteExpiresAt: string;
}

/** Çözülmüş oturum: profil, cihaz türü ve süre bilgileri. */
export interface ResolvedSession {
  sessionId: string;
  profile: UserProfile;
  deviceMode: DeviceMode;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
  lastSeenAt: string;
}

/** Aşırı satış (oversell) girişimi. Servis katmanı bunu 400'e çevirir. */
export class OversellError extends Error {
  constructor(
    readonly productId: string,
    readonly available: number,
  ) {
    super("Satış miktarı elinizdeki miktarı aşamaz.");
    this.name = "OversellError";
  }
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
  createSession(
    userId: string,
    deviceMode: DeviceMode,
    policy: SessionPolicy,
    now: number,
  ): Promise<SessionRecord>;
  /**
   * Jetonu çözer. Hem hareketsizlik hem mutlak süre kontrol edilir;
   * süresi geçen oturum reddedilir ve iptal edilir.
   */
  resolveSession(token: string, now: number): Promise<ResolvedSession | null>;
  /** Hareketsizlik penceresini ileri alır. Çağıran taraf sıklığı sınırlar. */
  touchSession(sessionId: string, idleExpiresAt: string | null, now: number): Promise<void>;
  destroySession(token: string): Promise<void>;
  /** Parola sıfırlama / pasifleştirme sonrası tüm cihazlardaki oturumları düşürür. */
  destroyAllSessionsForUser(userId: string): Promise<void>;
  /** Süresi geçmiş oturumları temizler. Döndürülen sayı silinen kayıt adedidir. */
  purgeExpiredSessions(now: number): Promise<number>;

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

  // --- Portföy verisi (DataScope ile korunur) ---
  getPortfolio(scope: DataScope): Promise<PortfolioMeta>;
  updatePortfolio(
    scope: DataScope,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta>;
  listTransactions(scope: DataScope): Promise<Transaction[]>;
  /** Aşırı satış kontrolü ATOMİK yapılır; eşzamanlı istekler kuralı bozamaz. */
  createTransaction(scope: DataScope, input: TransactionInput): Promise<Transaction>;
  updateTransaction(scope: DataScope, id: string, input: TransactionInput): Promise<Transaction>;
  deleteTransaction(scope: DataScope, id: string): Promise<void>;
  clearTransactions(scope: DataScope): Promise<void>;
}
