import { validatePassword } from "@/auth/password";
import { formatRetryAfter } from "@/auth/rate-limit";
import type { LoginRateLimiter } from "@/server/rate-limit/types";
import {
  SESSION_TOUCH_INTERVAL_MS,
  sessionPolicyFor,
  toSessionUser,
  type DeviceMode,
  type SessionPolicy,
  type SessionUser,
  type UserProfile,
} from "@/auth/types";
import { validateUsername } from "@/auth/username";
import type { AuthBackend, ResolvedSession } from "./backend";
import {
  createAdminActor,
  createUserActor,
  type AdminActor,
  type UserActor,
} from "./actor";
import {
  AppError,
  badRequest,
  forbidden,
  GENERIC_LOGIN_ERROR,
  passwordChangeRequired,
  tooManyRequests,
  unauthorized,
} from "./errors";

/**
 * Kimlik doğrulama ve oturum iş kuralları.
 *
 * Arka uçtan (Supabase / yerel) BAĞIMSIZDIR; bu sayede yetkilendirme ve hız
 * sınırlama kuralları tek yerden test edilebilir. Yönetim işlemleri
 * AdminService'te, kullanıcının kendi verisi UserPortfolioService'tedir.
 *
 * GÜVENLİK SINIRI
 * - Oturum süresi kontrolü SUNUCUDADIR (hem hareketsizlik hem mutlak süre).
 * - Geçici parolalı kullanıcı yalnızca oturum/çıkış/parola değiştirme
 *   uçlarını kullanabilir; diğer her şey PASSWORD_CHANGE_REQUIRED ile reddedilir.
 * - Rol yalnızca veritabanındaki profilden okunur; istemciden alınmaz.
 */

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: SessionUser;
  deviceMode: DeviceMode;
  policy: SessionPolicy;
}

export interface AuthServiceOptions {
  rateLimiter: LoginRateLimiter;
  now?: () => number;
}

export class AuthService {
  private readonly rateLimiter: LoginRateLimiter;
  private readonly now: () => number;

  constructor(
    private readonly backend: AuthBackend,
    options: AuthServiceOptions,
  ) {
    this.rateLimiter = options.rateLimiter;
    this.now = options.now ?? (() => Date.now());
  }

  get backendId(): AuthBackend["id"] {
    return this.backend.id;
  }

  get backendLabel(): string {
    return this.backend.label;
  }

  // ---------------------------------------------------------------- giriş

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

    const decision = await this.rateLimiter.check(limiterKey);
    if (!decision.allowed) {
      throw this.lockedOut(decision.retryAfterMs);
    }

    if (!username.ok || typeof password !== "string" || password.length === 0) {
      const failure = await this.rateLimiter.recordFailure(limiterKey);
      throw this.loginFailure(failure.retryAfterMs);
    }

    const profile = await this.backend.verifyCredentials(username.value, password);

    // Kullanıcı yok, parola yanlış ve hesap pasif durumları AYNI mesajı verir.
    if (!profile || profile.status !== "active") {
      const failure = await this.rateLimiter.recordFailure(limiterKey);
      throw this.loginFailure(failure.retryAfterMs);
    }

    await this.rateLimiter.reset(limiterKey);

    const policy = sessionPolicyFor(deviceMode);
    const session = await this.backend.createSession(profile.id, deviceMode, policy, this.now());
    await this.backend.recordLogin(profile.id);

    return {
      token: session.token,
      expiresAt: session.absoluteExpiresAt,
      user: toSessionUser(profile),
      deviceMode: session.deviceMode,
      policy,
    };
  }

  private lockedOut(retryAfterMs: number): AppError {
    return tooManyRequests(
      `Çok fazla başarısız giriş denemesi. ${formatRetryAfter(retryAfterMs)} sonra tekrar deneyin.`,
      retryAfterMs,
    );
  }

  private loginFailure(retryAfterMs: number): AppError {
    if (retryAfterMs > 0) return this.lockedOut(retryAfterMs);
    return new AppError(401, GENERIC_LOGIN_ERROR, "invalid_credentials");
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.backend.destroySession(token);
  }

  // ---------------------------------------------------------------- oturum

  /**
   * Jetonu çözer ve hareketsizlik penceresini gerekiyorsa ileri alır.
   * Süre kontrolü arka uçta yapılır; bu katman yalnızca tazelemeyi sınırlar.
   */
  async resolveSessionContext(token: string | null): Promise<ResolvedSession | null> {
    if (!token) return null;
    const now = this.now();
    const session = await this.backend.resolveSession(token, now);
    if (!session) return null;

    const policy = sessionPolicyFor(session.deviceMode);
    if (policy.idleTimeoutMs !== null) {
      // last_seen_at her istekte değil, en fazla SESSION_TOUCH_INTERVAL_MS'de bir yazılır.
      const lastSeen = Date.parse(session.lastSeenAt);
      if (!Number.isNaN(lastSeen) && now - lastSeen >= SESSION_TOUCH_INTERVAL_MS) {
        const nextIdle = new Date(now + policy.idleTimeoutMs).toISOString();
        await this.backend.touchSession(session.sessionId, nextIdle, now);
      }
    }
    return session;
  }

  /** Yalnızca profili döner; süre/rol kontrolü çağıranın sorumluluğundadır. */
  async resolveSession(token: string | null): Promise<UserProfile | null> {
    const session = await this.resolveSessionContext(token);
    return session?.profile ?? null;
  }

  /**
   * Oturum zorunlu — ancak parola değiştirmesi gereken kullanıcı da GEÇER.
   * Yalnızca /api/auth/session, /logout ve /change-password bu guard'ı kullanır.
   */
  async requireAuthenticatedUser(token: string | null): Promise<UserActor> {
    const session = await this.resolveSessionContext(token);
    if (!session) throw unauthorized();
    return createUserActor(session.profile, session.deviceMode);
  }

  /**
   * Uygulamayı kullanabilir durumda olan kullanıcı.
   * Geçici parolalı kullanıcı buradan GEÇEMEZ.
   */
  async requireUsableUser(token: string | null): Promise<UserActor> {
    const actor = await this.requireAuthenticatedUser(token);
    if (actor.profile.mustChangePassword) throw passwordChangeRequired();
    return actor;
  }

  /** Yönetici yetkisi her istekte veritabanındaki rolden doğrulanır. */
  async requireAdmin(token: string | null): Promise<AdminActor> {
    const actor = await this.requireUsableUser(token);
    if (actor.profile.role !== "admin") {
      throw forbidden("Bu alana yalnızca yöneticiler erişebilir.");
    }
    return createAdminActor(actor.profile, actor.deviceMode);
  }

  // ---------------------------------------------------------------- parola

  async changeOwnPassword(
    actor: UserActor,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!currentPassword || !newPassword) {
      throw badRequest("Mevcut ve yeni parolayı girin.");
    }
    if (currentPassword === newPassword) {
      throw badRequest("Yeni parola mevcut parolanızdan farklı olmalıdır.");
    }

    const policy = validatePassword(newPassword, actor.profile.username);
    if (!policy.ok) throw badRequest(policy.error ?? "Parola politikaya uymuyor.");

    const verified = await this.backend.verifyPasswordForUser(actor.profile.id, currentPassword);
    if (!verified) throw new AppError(401, "Mevcut parolanız hatalı.", "invalid_credentials");

    await this.backend.setPassword(actor.profile.id, newPassword);
    await this.backend.setMustChangePassword(actor.profile.id, false);
    // Diğer cihazlardaki oturumlar düşürülür; kullanıcı bu cihazda yeniden giriş yapar.
    await this.backend.destroyAllSessionsForUser(actor.profile.id);
  }

  /** Bakım görevi: süresi geçmiş oturumları siler. */
  async purgeExpiredSessions(): Promise<number> {
    return this.backend.purgeExpiredSessions(this.now());
  }
}
