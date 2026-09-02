import { validatePassword } from "@/auth/password";
import { formatRetryAfter } from "@/auth/rate-limit";
import {
  DEFAULT_LOGIN_RATE_LIMIT_POLICY,
  loginRateLimitBuckets,
  type LoginRateLimitBucket,
  type LoginRateLimitPolicy,
  type LoginRateLimiter,
} from "@/server/rate-limit/types";
import {
  SESSION_RENEWAL_INTERVAL_MS,
  SESSION_ROLLING_LIFETIME_MS,
  SESSION_ROTATION_GRACE_MS,
  SESSION_ROTATION_INTERVAL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  toSessionUser,
  type SessionSummary,
  type SessionUser,
  type UserProfile,
} from "@/auth/types";
import { validateUsername } from "@/auth/username";
import type { AuthBackend, ResolvedSession, SessionTouch } from "./backend";
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
 * OTURUM MODELİ (kalıcı, kaydırmalı, yenilenen kimlik)
 * - Oturum 180 gün kaydırmalı ömürlüdür; aktif kullanıcı süresiz oturumda kalır.
 * - Bitiş zamanı en fazla 24 saatte bir ileri alınır (her istekte DB yazımı yok).
 * - Oturum kimliği 7 günde bir sessizce yenilenir; eski kimlik 60 sn tolerans
 *   süresiyle kabul edilir. Hiç bitmeyen ve hiç değişmeyen jeton yoktur.
 * - Hareketsizlik zaman aşımı YOKTUR. Oturumu yalnızca açık çıkış veya güvenlik
 *   olayları (parola sıfırlama, pasifleştirme, yönetici iptali, silme) kapatır.
 *
 * GÜVENLİK SINIRI
 * - Geçici parolalı kullanıcı yalnızca oturum/çıkış/parola değiştirme
 *   uçlarını kullanabilir; diğer her şey PASSWORD_CHANGE_REQUIRED ile reddedilir.
 * - Rol yalnızca veritabanındaki profilden okunur; istemciden alınmaz.
 */

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

/** Çözülmüş oturum + bu istekte süresinin uzatılıp uzatılmadığı. */
export interface SessionContext extends ResolvedSession {
  /** true ise çerezin son kullanma tarihi de tazelenmelidir. */
  renewed: boolean;
}

export interface AuthServiceOptions {
  rateLimiter: LoginRateLimiter;
  /** Testlerde eşikleri küçültmek için. Üretimde varsayılan politika kullanılır. */
  loginRateLimits?: LoginRateLimitPolicy;
  now?: () => number;
}

export class AuthService {
  private readonly rateLimiter: LoginRateLimiter;
  private readonly loginRateLimits: LoginRateLimitPolicy;
  private readonly now: () => number;

  constructor(
    private readonly backend: AuthBackend,
    options: AuthServiceOptions,
  ) {
    this.rateLimiter = options.rateLimiter;
    this.loginRateLimits = options.loginRateLimits ?? DEFAULT_LOGIN_RATE_LIMIT_POLICY;
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
    deviceLabel = "Bilinmeyen cihaz",
  ): Promise<LoginResult> {
    const username = validateUsername(rawUsername ?? "");
    const buckets = loginRateLimitBuckets(clientKey, username.value, this.loginRateLimits);

    // Üç ayrı sayaç: yalnız IP, yalnız kullanıcı adı, IP + kullanıcı adı.
    // Herhangi biri kilitliyse giriş reddedilir.
    const decisions = await Promise.all(
      buckets.map((bucket) => this.rateLimiter.check(bucket.key, bucket.settings)),
    );
    const locked = decisions.find((decision) => !decision.allowed);
    if (locked) throw this.lockedOut(locked.retryAfterMs);

    if (!username.ok || typeof password !== "string" || password.length === 0) {
      throw this.loginFailure(await this.recordFailure(buckets));
    }

    const profile = await this.backend.verifyCredentials(username.value, password);

    // Kullanıcı yok, parola yanlış ve hesap pasif durumları AYNI mesajı verir.
    if (!profile || profile.status !== "active") {
      throw this.loginFailure(await this.recordFailure(buckets));
    }

    // Başarılı girişte yalnızca IP+kullanıcı kombinasyonu sıfırlanır; global
    // IP ve kullanıcı sayaçları saldırı korumasını sürdürür.
    await this.rateLimiter.reset(buckets[2].key);

    const session = await this.backend.createSession(profile.id, this.now(), deviceLabel);
    await this.backend.recordLogin(profile.id);

    return { token: session.token, expiresAt: session.expiresAt, user: toSessionUser(profile) };
  }

  /** Tüm sayaçlara başarısızlık yazar; en uzun bekleme süresini döner. */
  private async recordFailure(buckets: readonly LoginRateLimitBucket[]): Promise<number> {
    const results = await Promise.all(
      buckets.map((bucket) => this.rateLimiter.recordFailure(bucket.key, bucket.settings)),
    );
    return Math.max(0, ...results.map((result) => result.retryAfterMs));
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

  /** Normal çıkış: YALNIZCA bu cihazın oturumu kapanır. */
  async logout(token: string | null): Promise<void> {
    if (token) await this.backend.destroySession(token);
  }

  /** "Tüm cihazlardan çıkış": kullanıcının bütün oturumları iptal edilir. */
  async logoutEverywhere(actor: UserActor): Promise<number> {
    return this.backend.destroyAllSessionsForUser(actor.profile.id);
  }

  // ---------------------------------------------------------------- oturum

  /**
   * Jetonu çözer ve gerekiyorsa oturumu sessizce yeniler (kaydırmalı süre).
   * Veritabanına en fazla SESSION_TOUCH_INTERVAL_MS'de bir yazılır; bitiş
   * zamanı en fazla SESSION_RENEWAL_INTERVAL_MS'de bir ileri alınır.
   */
  async resolveSessionContext(token: string | null): Promise<SessionContext | null> {
    if (!token) return null;
    const now = this.now();
    const session = await this.backend.resolveSession(token, now);
    if (!session) return null;

    const lastSeen = Date.parse(session.lastSeenAt);
    const renewedAt = Date.parse(session.renewedAt);
    const touchDue = Number.isNaN(lastSeen) || now - lastSeen >= SESSION_TOUCH_INTERVAL_MS;
    const renewDue = Number.isNaN(renewedAt) || now - renewedAt >= SESSION_RENEWAL_INTERVAL_MS;

    if (!touchDue && !renewDue) return { ...session, renewed: false };

    const patch: SessionTouch = { lastSeenAt: new Date(now).toISOString() };
    if (renewDue) {
      patch.expiresAt = new Date(now + SESSION_ROLLING_LIFETIME_MS).toISOString();
      patch.renewedAt = patch.lastSeenAt;
    }
    await this.backend.touchSession(session.sessionId, patch);

    return {
      ...session,
      lastSeenAt: patch.lastSeenAt,
      expiresAt: patch.expiresAt ?? session.expiresAt,
      renewedAt: patch.renewedAt ?? session.renewedAt,
      renewed: renewDue,
    };
  }

  /** Oturum kimliğinin yenilenme zamanı geldi mi? */
  rotationDue(session: ResolvedSession): boolean {
    const rotatedAt = Date.parse(session.rotatedAt);
    return Number.isNaN(rotatedAt) || this.now() - rotatedAt >= SESSION_ROTATION_INTERVAL_MS;
  }

  /**
   * Zamanı geldiyse oturum kimliğini yeniler ve YENİ jetonu döner; aksi hâlde
   * null. Eski jeton kısa bir tolerans süresi boyunca kabul edilmeye devam eder.
   */
  async rotateSessionIfDue(session: ResolvedSession): Promise<string | null> {
    if (!this.rotationDue(session)) return null;
    return this.backend.rotateSession(session.sessionId, this.now(), SESSION_ROTATION_GRACE_MS);
  }

  /** Yalnızca profili döner; süre/rol kontrolü çağıranın sorumluluğundadır. */
  async resolveSession(token: string | null): Promise<UserProfile | null> {
    const session = await this.resolveSessionContext(token);
    return session?.profile ?? null;
  }

  /** Kullanıcının kendi aktif oturumları (güvenli metadata). */
  async listOwnSessions(actor: UserActor): Promise<SessionSummary[]> {
    const rows = await this.backend.listSessionsForUser(actor.profile.id, this.now());
    return rows.map((row) => ({ ...row, current: row.id === actor.sessionId }));
  }

  // ---------------------------------------------------------------- aktörler

  /** Çözülmüş oturumdan kullanıcı aktörü. Geçici parolalı kullanıcı da GEÇER. */
  userActorFrom(session: ResolvedSession | null): UserActor {
    if (!session) throw unauthorized();
    return createUserActor(session.profile, session.sessionId);
  }

  /** Uygulamayı kullanabilir kullanıcı. Geçici parolalı kullanıcı GEÇEMEZ. */
  usableActorFrom(session: ResolvedSession | null): UserActor {
    const actor = this.userActorFrom(session);
    if (actor.profile.mustChangePassword) throw passwordChangeRequired();
    return actor;
  }

  /** Yönetici yetkisi her istekte veritabanındaki rolden doğrulanır. */
  adminActorFrom(session: ResolvedSession | null): AdminActor {
    const actor = this.usableActorFrom(session);
    if (actor.profile.role !== "admin") {
      throw forbidden("Bu alana yalnızca yöneticiler erişebilir.");
    }
    return createAdminActor(actor.profile, actor.sessionId);
  }

  /**
   * Oturum zorunlu — ancak parola değiştirmesi gereken kullanıcı da GEÇER.
   * Yalnızca /api/auth/session, /logout(-all) ve /change-password bunu kullanır.
   */
  async requireAuthenticatedUser(token: string | null): Promise<UserActor> {
    return this.userActorFrom(await this.resolveSessionContext(token));
  }

  /** Geçici parolalı kullanıcı buradan GEÇEMEZ. */
  async requireUsableUser(token: string | null): Promise<UserActor> {
    return this.usableActorFrom(await this.resolveSessionContext(token));
  }

  async requireAdmin(token: string | null): Promise<AdminActor> {
    return this.adminActorFrom(await this.resolveSessionContext(token));
  }

  // ---------------------------------------------------------------- parola

  /**
   * Kullanıcının kendi parolasını değiştirmesi. Mevcut cihazdaki oturum
   * KORUNUR; diğer bütün cihazlar güvenlik için kapatılır.
   */
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
    await this.backend.destroyAllSessionsForUser(actor.profile.id, {
      exceptSessionId: actor.sessionId,
    });
  }

  /** Bakım görevi: süresi geçmiş / iptal edilmiş oturumları siler. */
  async purgeExpiredSessions(): Promise<number> {
    return this.backend.purgeExpiredSessions(this.now());
  }
}
