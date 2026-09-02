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
export interface LoginRateLimiter {
  readonly id: "memory" | "postgres";
  /** Denemeye izin verilip verilmediğini söyler; sayaç ARTIRMAZ. */
  check(key: string): Promise<RateLimitDecision>;
  /** Başarısız denemeyi kaydeder ve gerekiyorsa bekleme uygular. */
  recordFailure(key: string): Promise<RateLimitDecision>;
  /** Başarılı girişte sayaç sıfırlanır. */
  reset(key: string): Promise<void>;
}

/** Sınırlayıcı ayarları. İki uygulamada da aynı davranışı verir. */
export interface RateLimitSettings {
  maxAttempts: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}

export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 60 * 1000,
  maxLockMs: 15 * 60 * 1000,
};
