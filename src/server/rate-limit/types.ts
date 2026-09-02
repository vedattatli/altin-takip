import type { RateLimitDecision } from "@/auth/rate-limit";

export type { RateLimitDecision };

/**
 * Giriş hız sınırlayıcı sözleşmesi.
 *
 * İki uygulaması vardır:
 *  - MemoryLoginRateLimiter   : geliştirme/test. Süreç belleğinde.
 *  - PostgresLoginRateLimiter : üretim. Supabase Postgres'te paylaşımlı,
 *                               birden çok Next.js/Vercel örneği arasında ortak.
 *
 * ANAHTAR GİZLİLİĞİ
 * Ham anahtar (IP + kullanıcı adı) hiçbir uygulamada SAKLANMAZ. Anahtar
 * RATE_LIMIT_PEPPER ile HMAC-SHA256'dan geçirilir ve yalnızca özeti tutulur.
 */

/** Sınırlayıcı ayarları. İki uygulamada da aynı davranışı verir. */
export interface RateLimitSettings {
  maxAttempts: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}

export interface LoginRateLimiter {
  readonly id: "memory" | "postgres";
  /** Denemeye izin verilip verilmediğini söyler; sayaç ARTIRMAZ. */
  check(key: string, settings?: RateLimitSettings): Promise<RateLimitDecision>;
  /** Başarısız denemeyi kaydeder ve gerekiyorsa bekleme uygular. */
  recordFailure(key: string, settings?: RateLimitSettings): Promise<RateLimitDecision>;
  /** Sayacı sıfırlar. */
  reset(key: string): Promise<void>;
}

export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 60 * 1000,
  maxLockMs: 15 * 60 * 1000,
};

/**
 * ÜÇLÜ SAYAÇ MODELİ
 *
 * Tek "IP|kullanıcı" sayacı iki saldırıyı kaçırır: aynı IP'den çok sayıda
 * farklı kullanıcı adı denemek (credential stuffing) ve bir kullanıcı adını
 * çok sayıda IP'den denemek (dağıtık deneme). Bu yüzden üç ayrı sayaç tutulur.
 * Kombinasyon sayacı en sıkı, global sayaçlar daha geniş eşiklidir.
 */
export const PAIR_RATE_LIMIT_SETTINGS: RateLimitSettings = DEFAULT_RATE_LIMIT_SETTINGS;

export const IP_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  maxAttempts: 20,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 60 * 1000,
  maxLockMs: 30 * 60 * 1000,
};

export const USERNAME_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 60 * 1000,
  maxLockMs: 30 * 60 * 1000,
};

export interface LoginRateLimitPolicy {
  ip: RateLimitSettings;
  username: RateLimitSettings;
  pair: RateLimitSettings;
}

export const DEFAULT_LOGIN_RATE_LIMIT_POLICY: LoginRateLimitPolicy = {
  ip: IP_RATE_LIMIT_SETTINGS,
  username: USERNAME_RATE_LIMIT_SETTINGS,
  pair: PAIR_RATE_LIMIT_SETTINGS,
};

export interface LoginRateLimitBucket {
  kind: "ip" | "username" | "pair";
  /** Ham anahtar; sınırlayıcı bunu saklamadan önce HMAC ile gizler. */
  key: string;
  settings: RateLimitSettings;
}

/** Bir giriş denemesi için kontrol edilecek üç sayaç. Sıra: ip, username, pair. */
export function loginRateLimitBuckets(
  clientIp: string,
  normalizedUsername: string,
  policy: LoginRateLimitPolicy = DEFAULT_LOGIN_RATE_LIMIT_POLICY,
): LoginRateLimitBucket[] {
  const user = normalizedUsername || "?";
  return [
    { kind: "ip", key: `ip:${clientIp}`, settings: policy.ip },
    { kind: "username", key: `user:${user}`, settings: policy.username },
    { kind: "pair", key: `pair:${clientIp}|${user}`, settings: policy.pair },
  ];
}
