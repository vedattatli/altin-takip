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
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
  BROWSER_SESSION_ABSOLUTE_MS,
  BROWSER_SESSION_IDLE_MS,
  NON_PERSISTENT_TOUCH_INTERVAL_MS,
  SESSION_RENEWAL_INTERVAL_MS,
  SESSION_ROLLING_LIFETIME_MS,
  SESSION_ROTATION_GRACE_MS,
  SESSION_ROTATION_INTERVAL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  toSessionUser,
  type SessionSummary,
  type SessionUser,
  type UserProfile,
  type UserRole,
} from "@/auth/types";
import { isReservedUsername, validateUsername } from "@/auth/username";
import type { AuthBackend, ResolvedSession, SessionPolicy, SessionTouch } from "./backend";
import {
  createAdminActor,
  createUserActor,
  type AdminActor,
  type UserActor,
} from "./actor";
import {
  AppError,
  badRequest,
  conflict,
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
 * OTURUM POLİTİKASI (bkz. src/auth/types.ts)
 * - Kalıcı (kullanıcı "oturumumu açık tut" seçti): 180 gün kaydırmalı ömür,
 *   ≤ 24 saatte bir yenileme, 7 günde bir sessiz kimlik yenileme.
 * - Tarayıcı oturumu: 8 saat mutlak + 30 dk hareketsizlik; çerez kalıcı değil.
 * - Admin: tercihten bağımsız 8 saat mutlak + 15 dk hareketsizlik; asla kalıcı değil.
 *   Bu kural çözümleme anında da uygulanır: kalıcı işaretli bir admin oturumu reddedilir.
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
  /** Çerezin kalıcı olup olmayacağı (route bunu çerez seçeneklerine yansıtır). */
  persistent: boolean;
}

/** Çözülmüş oturum + bu istekte süresinin uzatılıp uzatılmadığı. */
export interface SessionContext extends ResolvedSession {
  /** true ise çerezin son kullanma tarihi de tazelenmelidir (yalnızca kalıcı oturum). */
  renewed: boolean;
}

export interface AuthServiceOptions {
  rateLimiter: LoginRateLimiter;
  /** Testlerde eşikleri küçültmek için. Üretimde varsayılan politika kullanılır. */
  loginRateLimits?: LoginRateLimitPolicy;
  now?: () => number;
}

/** Rol ve tercihe göre oturum ömür politikası. Admin asla kalıcı olmaz. */
export function sessionPolicyFor(role: UserRole, keepSignedIn: boolean): SessionPolicy {
  if (role === "admin") {
    return {
      persistent: false,
      idleTimeoutMs: ADMIN_SESSION_IDLE_MS,
      absoluteLifetimeMs: ADMIN_SESSION_ABSOLUTE_MS,
    };
  }
  if (keepSignedIn) {
    return { persistent: true, idleTimeoutMs: null, absoluteLifetimeMs: SESSION_ROLLING_LIFETIME_MS };
  }
  return {
    persistent: false,
    idleTimeoutMs: BROWSER_SESSION_IDLE_MS,
    absoluteLifetimeMs: BROWSER_SESSION_ABSOLUTE_MS,
  };
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

  /**
   * HERKESE AÇIK KAYIT.
   *
   * Ürün kararı (sahibi verdi): siteye giren herkes kendi hesabını açabilir.
   * Önceki model "hesapları yalnızca yönetici açar" idi.
   *
   * BU UÇ İNTERNETE AÇIKTIR; korumalar bu yüzden bilerek sıkı tutuldu:
   *  - Giriş ucuyla AYNI hız sınırlayıcıdan geçer (IP, kullanıcı adı, çift).
   *    Aksi hâlde otomatik araçlar sınırsız hesap açardı.
   *  - Rol İSTEMCİDEN ALINMAZ; her kayıt `user` rolüyle açılır. `admin` rolü
   *    yalnızca `npm run admin:create` ile verilir.
   *  - Kullanıcı adı doğrulanır, ayrılmış adlar reddedilir, benzersizdir.
   *  - Parola politikası giriş/parola değiştirme ile AYNI fonksiyondan geçer.
   *  - Parola tekrarı sunucuda da denetlenir; istemci kontrolü yeterli değildir.
   *
   * `mustChangePassword` KURULMAZ: parolayı kullanıcı kendi seçti, ilk girişte
   * yeniden sormak anlamsız olurdu (yönetici geçici parola verdiğinde kurulur).
   *
   * E-posta veya telefon doğrulaması YOKTUR (uygulamanın böyle bir kanalı yok).
   * Bunun sonucu açıktır: kullanıcı adı sahipliği doğrulanmaz ve parolasını
   * unutan kullanıcıyı YALNIZCA yönetici kurtarabilir.
   */
  async register(
    input: { username: string; displayName: string; password: string; passwordConfirm: string },
    clientKey: string,
  ): Promise<UserProfile> {
    const username = validateUsername(input.username ?? "");
    const buckets = loginRateLimitBuckets(clientKey, username.value, this.loginRateLimits);
    const decisions = await Promise.all(
      buckets.map((bucket) => this.rateLimiter.check(bucket.key, bucket.settings)),
    );
    const locked = decisions.find((decision) => !decision.allowed);
    if (locked) throw this.lockedOut(locked.retryAfterMs);

    if (!username.ok) {
      await this.recordFailure(buckets);
      throw badRequest(username.error ?? "Kullanıcı adı geçersiz.");
    }
    if (isReservedUsername(username.value)) {
      await this.recordFailure(buckets);
      throw badRequest("Bu kullanıcı adı sistem tarafından ayrılmıştır.");
    }

    const displayName = (input.displayName ?? "").trim();
    if (displayName.length < 2 || displayName.length > 80) {
      throw badRequest("Görünen ad 2-80 karakter olmalıdır.");
    }

    if (input.password !== input.passwordConfirm) {
      throw badRequest("Parolalar birbiriyle eşleşmiyor.");
    }
    const policy = validatePassword(input.password ?? "", username.value);
    if (!policy.ok) {
      throw badRequest(policy.error ?? "Parola politikaya uymuyor.");
    }

    const existing = await this.backend.findProfileByUsername(username.value);
    if (existing) {
      // Sayaç ilerletilir: kullanıcı adı taraması ücretsiz olmasın.
      await this.recordFailure(buckets);
      throw conflict("Bu kullanıcı adı zaten kullanılıyor.");
    }

    const created = await this.backend.createUser({
      username: username.value,
      displayName,
      temporaryPassword: input.password,
      role: "user",
    });
    // Parolayı kullanıcı seçti; ilk girişte değiştirmesi istenmez.
    await this.backend.setMustChangePassword(created.id, false);
    return { ...created, mustChangePassword: false };
  }

  async login(
    rawUsername: string,
    password: string,
    clientKey: string,
    deviceLabel = "Bilinmeyen cihaz",
    keepSignedIn = false,
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

    const policy = sessionPolicyFor(profile.role, keepSignedIn === true);
    const session = await this.backend.createSession(profile.id, this.now(), deviceLabel, policy);
    await this.backend.recordLogin(profile.id);

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: toSessionUser(profile),
      persistent: policy.persistent,
    };
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
   * Jetonu çözer ve politikaya göre oturumu ilerletir.
   *
   * Kalıcı oturum: last_seen ≤ 15 dk'da bir, bitiş ≤ 24 saatte bir yazılır.
   * Tarayıcı / admin oturumu: hareketsizlik penceresi ≤ 60 sn'de bir ileri alınır;
   * mutlak bitiş hiç uzatılmaz. Her istekte DB yazımı yoktur.
   */
  async resolveSessionContext(token: string | null): Promise<SessionContext | null> {
    if (!token) return null;
    const now = this.now();
    const session = await this.backend.resolveSession(token, now);
    if (!session) return null;

    const isAdmin = session.profile.role === "admin";
    const lastSeen = Date.parse(session.lastSeenAt);

    if (isAdmin || !session.persistent) {
      // Admin asla kalıcı olamaz; kalıcı işaretli eski bir admin oturumu reddedilir.
      if (isAdmin && session.persistent) return null;
      // Mutlak ömür: admin için 8 saat (kayıt ne derse desin), diğerleri kayıttaki bitiş.
      const created = Date.parse(session.createdAt);
      if (isAdmin && !Number.isNaN(created) && now - created >= ADMIN_SESSION_ABSOLUTE_MS) {
        await this.backend.destroySessionById(session.profile.id, session.sessionId);
        return null;
      }
      const idleMs = isAdmin ? ADMIN_SESSION_IDLE_MS : BROWSER_SESSION_IDLE_MS;
      // Hareketsizlik: kayıttaki idle bitişi arka uçta kontrol edildi; ek olarak
      // last_seen üzerinden de doğrulanır (kayıt eksikse fail closed).
      if (session.idleExpiresAt === null || Number.isNaN(lastSeen) || now - lastSeen >= idleMs) {
        await this.backend.destroySessionById(session.profile.id, session.sessionId);
        return null;
      }
      if (now - lastSeen >= NON_PERSISTENT_TOUCH_INTERVAL_MS) {
        const patch: SessionTouch = {
          lastSeenAt: new Date(now).toISOString(),
          idleExpiresAt: new Date(now + idleMs).toISOString(),
        };
        await this.backend.touchSession(session.sessionId, patch);
        return { ...session, lastSeenAt: patch.lastSeenAt, idleExpiresAt: patch.idleExpiresAt ?? null, renewed: false };
      }
      return { ...session, renewed: false };
    }

    // Kalıcı oturum: kaydırmalı yenileme.
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
      absoluteExpiresAt: patch.expiresAt ?? session.absoluteExpiresAt,
      renewedAt: patch.renewedAt ?? session.renewedAt,
      renewed: renewDue,
    };
  }

  /** Oturum kimliğinin yenilenme zamanı geldi mi? (Yalnızca kalıcı oturumlar yenilenir.) */
  rotationDue(session: ResolvedSession): boolean {
    if (!session.persistent) return false;
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
   * Yönetici + ikinci faktör.
   * MFA kurulmamış veya bu oturumda doğrulanmamışsa yönetim işlemleri REDDEDİLİR.
   */
  async adminActorWithMfa(session: ResolvedSession | null): Promise<AdminActor> {
    const actor = this.adminActorFrom(session);
    const { MfaService } = await import("./mfa-service");
    await new MfaService(this.backend, { now: () => this.now() }).assertSessionSatisfiesMfa(
      actor.profile,
      session?.mfaVerifiedAt ?? null,
    );
    return actor;
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
    return this.adminActorWithMfa(await this.resolveSessionContext(token));
  }

  /** İkinci faktör kurulumu/doğrulaması için: admin rolü yeter, MFA aranmaz. */
  async requireAdminForMfaSetup(token: string | null): Promise<AdminActor> {
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
