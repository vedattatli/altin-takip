import { validatePassword } from "@/auth/password";
import { formatRetryAfter, LoginRateLimiter } from "@/auth/rate-limit";
import {
  ADMIN_CAN_EDIT_USER_PORTFOLIO,
  type AdminAction,
  type DeviceMode,
  type AdminAuditLog,
  type SessionUser,
  type UserProfile,
  type UserStatus,
  toSessionUser,
} from "@/auth/types";
import { isReservedUsername, validateUsername } from "@/auth/username";
import { buildPortfolio, type PortfolioSummary } from "@/domain/portfolio";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { Transaction } from "@/domain/types";
import { MockPriceProvider } from "@/prices/mock-provider";
import type { AuthBackend, ResolvedSession } from "./backend";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  GENERIC_LOGIN_ERROR,
  notFound,
  tooManyRequests,
  unauthorized,
} from "./errors";

/**
 * Kimlik doğrulama ve yönetim iş kuralları.
 *
 * Arka uçtan (Supabase / yerel) BAĞIMSIZDIR; bu sayede yetkilendirme,
 * denetim kaydı ve hız sınırlama kuralları tek yerden test edilebilir.
 *
 * GÜVENLİK KURALLARI
 * - Rol yalnızca sunucuda atanır. Panelden oluşturulan her kullanıcı "user" olur;
 *   "admin" rolü yalnızca bootstrap CLI ile verilir.
 * - Admin uçlarına erişim her istekte veritabanındaki role bakılarak doğrulanır.
 * - Menüyü gizlemek yetkilendirme sayılmaz; kontrol burada yapılır.
 */

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: SessionUser;
  deviceMode: DeviceMode;
}

export interface AdminUserPortfolioView {
  user: UserProfile;
  summary: PortfolioSummary;
  transactions: Transaction[];
  /** Adminin bu portföyü düzenleme yetkisi. İlk sürümde kapalı. */
  canEdit: boolean;
}

export interface AuthServiceOptions {
  rateLimiter?: LoginRateLimiter;
  sessionTtlMs?: number;
  now?: () => number;
}

export class AuthService {
  private readonly rateLimiter: LoginRateLimiter;
  private readonly sessionTtlMs: number;

  constructor(
    private readonly backend: AuthBackend,
    options: AuthServiceOptions = {},
  ) {
    this.rateLimiter = options.rateLimiter ?? new LoginRateLimiter();
    this.sessionTtlMs = options.sessionTtlMs ?? 14 * 24 * 60 * 60 * 1000;
  }

  get backendId(): AuthBackend["id"] {
    return this.backend.id;
  }

  get backendLabel(): string {
    return this.backend.label;
  }

  // ---------------------------------------------------------------- oturum

  async login(
    rawUsername: string,
    password: string,
    clientKey: string,
    // Bilinmeyen/eksik değerde EN KISITLAYICI mod seçilir.
    deviceMode: DeviceMode = "shared",
  ): Promise<LoginResult> {
    const username = validateUsername(rawUsername ?? "");
    // Hız sınırı hem kullanıcı adına hem de isteği yapan istemciye bakar.
    const limiterKey = `${clientKey}|${username.value || "?"}`;

    const decision = this.rateLimiter.check(limiterKey);
    if (!decision.allowed) {
      throw tooManyRequests(
        `Çok fazla başarısız giriş denemesi. ${formatRetryAfter(decision.retryAfterMs)} sonra tekrar deneyin.`,
        decision.retryAfterMs,
      );
    }

    if (!username.ok || typeof password !== "string" || password.length === 0) {
      const failure = this.rateLimiter.recordFailure(limiterKey);
      throw this.loginFailure(failure.retryAfterMs);
    }

    const profile = await this.backend.verifyCredentials(username.value, password);

    // Kullanıcı yok, parola yanlış ve hesap pasif durumları AYNI mesajı verir.
    if (!profile || profile.status !== "active") {
      const failure = this.rateLimiter.recordFailure(limiterKey);
      throw this.loginFailure(failure.retryAfterMs);
    }

    this.rateLimiter.reset(limiterKey);
    const session = await this.backend.createSession(profile.id, this.sessionTtlMs, deviceMode);
    await this.backend.recordLogin(profile.id);

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: toSessionUser(profile),
      deviceMode: session.deviceMode,
    };
  }

  private loginFailure(retryAfterMs: number): AppError {
    if (retryAfterMs > 0) {
      return tooManyRequests(
        `Çok fazla başarısız giriş denemesi. ${formatRetryAfter(retryAfterMs)} sonra tekrar deneyin.`,
        retryAfterMs,
      );
    }
    return new AppError(401, GENERIC_LOGIN_ERROR, "invalid_credentials");
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.backend.destroySession(token);
  }

  /** Oturum çerezinden profili ve cihaz modunu çözer. */
  async resolveSessionContext(token: string | null): Promise<ResolvedSession | null> {
    if (!token) return null;
    return this.backend.resolveSession(token);
  }

  /** Oturum çerezinden profili çözer. Pasifleştirilen kullanıcı null döner. */
  async resolveSession(token: string | null): Promise<UserProfile | null> {
    const session = await this.resolveSessionContext(token);
    return session?.profile ?? null;
  }

  async requireUser(token: string | null): Promise<UserProfile> {
    const profile = await this.resolveSession(token);
    if (!profile) throw unauthorized();
    return profile;
  }

  /** Admin yetkisini her istekte veritabanındaki role bakarak doğrular. */
  async requireAdmin(token: string | null): Promise<UserProfile> {
    const profile = await this.requireUser(token);
    if (profile.role !== "admin") throw forbidden("Bu alana yalnızca yöneticiler erişebilir.");
    return profile;
  }

  // ------------------------------------------------------------ parola

  async changeOwnPassword(
    actor: UserProfile,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!currentPassword || !newPassword) {
      throw badRequest("Mevcut ve yeni parolayı girin.");
    }
    if (currentPassword === newPassword) {
      throw badRequest("Yeni parola mevcut parolanızdan farklı olmalıdır.");
    }

    const policy = validatePassword(newPassword, actor.username);
    if (!policy.ok) throw badRequest(policy.error ?? "Parola politikaya uymuyor.");

    const verified = await this.backend.verifyPasswordForUser(actor.id, currentPassword);
    if (!verified) throw new AppError(401, "Mevcut parolanız hatalı.", "invalid_credentials");

    await this.backend.setPassword(actor.id, newPassword);
    await this.backend.setMustChangePassword(actor.id, false);
    // Diğer cihazlardaki oturumlar düşürülür; kullanıcı bu cihazda yeniden giriş yapar.
    await this.backend.destroyAllSessionsForUser(actor.id);
  }

  // ------------------------------------------------------------ yönetim

  private async audit(
    actor: UserProfile,
    action: AdminAction,
    target: UserProfile | null,
    success: boolean,
    metadata: AdminAuditLog["metadata"] = {},
  ): Promise<void> {
    // Parola, tutar veya finansal içerik ASLA metadata'ya yazılmaz.
    await this.backend.appendAudit({
      adminUserId: actor.id,
      adminUsername: actor.username,
      targetUserId: target?.id ?? null,
      targetUsername: target?.username ?? null,
      action,
      success,
      metadata,
    });
  }

  async listUsers(actor: UserProfile, search?: string): Promise<UserProfile[]> {
    this.assertAdmin(actor);
    return this.backend.listProfiles({ search, limit: 200 });
  }

  async listAudit(actor: UserProfile, limit = 100): Promise<AdminAuditLog[]> {
    this.assertAdmin(actor);
    return this.backend.listAudit(limit);
  }

  private assertAdmin(actor: UserProfile): void {
    if (actor.role !== "admin") throw forbidden("Bu işlem için yönetici yetkisi gerekiyor.");
  }

  async getUserDetail(actor: UserProfile, userId: string): Promise<UserProfile> {
    this.assertAdmin(actor);
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.view", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    await this.audit(actor, "user.view", target, true);
    return target;
  }

  async getUserPortfolio(actor: UserProfile, userId: string): Promise<AdminUserPortfolioView> {
    this.assertAdmin(actor);
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.portfolio_view", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }

    const transactions = await this.backend.listTransactions(userId);
    const snapshot = await new MockPriceProvider().getQuotes(GOLD_PRODUCTS.map((p) => p.id));
    const summary = buildPortfolio(transactions, snapshot);

    // Denetim kaydına yalnızca sayısal olmayan, hassas olmayan özet yazılır.
    await this.audit(actor, "user.portfolio_view", target, true, {
      transactionCount: transactions.length,
    });

    return { user: target, summary, transactions, canEdit: ADMIN_CAN_EDIT_USER_PORTFOLIO };
  }

  async createUser(
    actor: UserProfile,
    input: { username: string; displayName: string; temporaryPassword: string },
  ): Promise<UserProfile> {
    this.assertAdmin(actor);

    const username = validateUsername(input.username ?? "");
    if (!username.ok) {
      await this.audit(actor, "user.create", null, false, { reason: "invalid_username" });
      throw badRequest(username.error ?? "Kullanıcı adı geçersiz.");
    }
    if (isReservedUsername(username.value)) {
      await this.audit(actor, "user.create", null, false, { reason: "reserved_username" });
      throw badRequest("Bu kullanıcı adı sistem tarafından ayrılmıştır.");
    }

    const displayName = (input.displayName ?? "").trim();
    if (displayName.length < 2 || displayName.length > 80) {
      await this.audit(actor, "user.create", null, false, { reason: "invalid_display_name" });
      throw badRequest("Görünen ad 2-80 karakter olmalıdır.");
    }

    const policy = validatePassword(input.temporaryPassword ?? "", username.value);
    if (!policy.ok) {
      await this.audit(actor, "user.create", null, false, { reason: "weak_password" });
      throw badRequest(policy.error ?? "Geçici parola politikaya uymuyor.");
    }

    const existing = await this.backend.findProfileByUsername(username.value);
    if (existing) {
      await this.audit(actor, "user.create", existing, false, { reason: "duplicate_username" });
      throw conflict("Bu kullanıcı adı zaten kullanılıyor.");
    }

    // Rol İSTEMCİDEN ALINMAZ. Panelden oluşturulan her hesap normal kullanıcıdır.
    const created = await this.backend.createUser({
      username: username.value,
      displayName,
      temporaryPassword: input.temporaryPassword,
      role: "user",
    });

    await this.audit(actor, "user.create", created, true, { mustChangePassword: true });
    return created;
  }

  async setUserStatus(
    actor: UserProfile,
    userId: string,
    status: UserStatus,
  ): Promise<UserProfile> {
    this.assertAdmin(actor);
    const action: AdminAction = status === "inactive" ? "user.deactivate" : "user.activate";

    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, action, null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    if (status === "inactive" && target.id === actor.id) {
      await this.audit(actor, action, target, false, { reason: "self_deactivation" });
      throw badRequest("Kendi hesabınızı pasifleştiremezsiniz.");
    }
    if (status === "inactive" && target.role === "admin") {
      const admins = await this.backend.countAdmins();
      if (admins <= 1) {
        await this.audit(actor, action, target, false, { reason: "last_admin" });
        throw badRequest("Sistemdeki son aktif yönetici pasifleştirilemez.");
      }
    }

    const updated = await this.backend.setStatus(userId, status);
    if (status === "inactive") {
      // Mevcut erişim mümkün olan en kısa sürede kesilir.
      await this.backend.destroyAllSessionsForUser(userId);
    }
    await this.audit(actor, action, updated, true);
    return updated;
  }

  async resetUserPassword(
    actor: UserProfile,
    userId: string,
    temporaryPassword: string,
  ): Promise<UserProfile> {
    this.assertAdmin(actor);

    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.password_reset", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }

    const policy = validatePassword(temporaryPassword ?? "", target.username);
    if (!policy.ok) {
      await this.audit(actor, "user.password_reset", target, false, { reason: "weak_password" });
      throw badRequest(policy.error ?? "Geçici parola politikaya uymuyor.");
    }

    await this.backend.setPassword(userId, temporaryPassword);
    const updated = await this.backend.setMustChangePassword(userId, true);
    // Parola sıfırlandığında tüm aktif oturumlar geçersiz olur.
    await this.backend.destroyAllSessionsForUser(userId);

    // Parola audit log'a YAZILMAZ.
    await this.audit(actor, "user.password_reset", updated, true, { mustChangePassword: true });
    return updated;
  }

  /**
   * Kalıcı silme. Varsayılan yönetim işlemi DEĞİLDİR; pasifleştirme tercih edilir.
   * Silme için hedefin kullanıcı adının birebir yazılması zorunludur.
   */
  async deleteUser(
    actor: UserProfile,
    userId: string,
    confirmationUsername: string,
  ): Promise<void> {
    this.assertAdmin(actor);

    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.delete_attempt", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    if (target.id === actor.id) {
      await this.audit(actor, "user.delete_attempt", target, false, { reason: "self_delete" });
      throw badRequest("Kendi hesabınızı silemezsiniz.");
    }

    const confirmation = validateUsername(confirmationUsername ?? "");
    if (!confirmation.ok || confirmation.value !== target.username) {
      await this.audit(actor, "user.delete_attempt", target, false, {
        reason: "confirmation_mismatch",
      });
      throw badRequest(
        "Silme onayı eşleşmedi. Kalıcı silme için kullanıcı adını birebir yazmalısınız.",
      );
    }

    if (target.role === "admin") {
      const admins = await this.backend.countAdmins();
      if (admins <= 1) {
        await this.audit(actor, "user.delete_attempt", target, false, { reason: "last_admin" });
        throw badRequest("Sistemdeki son aktif yönetici silinemez.");
      }
    }

    await this.audit(actor, "user.delete_attempt", target, true, { confirmed: true });
    await this.backend.destroyAllSessionsForUser(userId);
    await this.backend.deleteUser(userId);
    await this.audit(actor, "user.delete", target, true, { cascade: "portfolio_and_transactions" });
  }
}
