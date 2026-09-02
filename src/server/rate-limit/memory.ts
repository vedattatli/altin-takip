import { SlidingWindowRateLimiter } from "@/auth/rate-limit";
import { hashRateLimitKey } from "./key";
import {
  DEFAULT_RATE_LIMIT_SETTINGS,
  type LoginRateLimiter,
  type RateLimitDecision,
  type RateLimitSettings,
} from "./types";

/**
 * Süreç belleğinde çalışan hız sınırlayıcı.
 *
 * YALNIZCA geliştirme ve test içindir. Çok örnekli üretim dağıtımında sayaç
 * örnekler arasında bölüneceği için kullanılmaz; üretimde Postgres tabanlı
 * paylaşımlı uygulama zorunludur (bkz. createLoginRateLimiter).
 */
export class MemoryLoginRateLimiter implements LoginRateLimiter {
  readonly id = "memory" as const;
  private readonly inner: SlidingWindowRateLimiter;

  constructor(
    private readonly pepper: string,
    settings: RateLimitSettings = DEFAULT_RATE_LIMIT_SETTINGS,
    now?: () => number,
  ) {
    this.inner = new SlidingWindowRateLimiter({ ...settings, now });
  }

  private hash(key: string): string {
    return hashRateLimitKey(key, this.pepper);
  }

  async check(key: string): Promise<RateLimitDecision> {
    return this.inner.check(this.hash(key));
  }

  async recordFailure(key: string): Promise<RateLimitDecision> {
    return this.inner.recordFailure(this.hash(key));
  }

  async reset(key: string): Promise<void> {
    this.inner.reset(this.hash(key));
  }

  /** Testler için. */
  clear(): void {
    this.inner.clear();
  }
}
