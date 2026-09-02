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
 *
 * Her farklı ayar seti için ayrı bir kayan pencere örneği tutulur; böylece
 * IP / kullanıcı adı / kombinasyon sayaçları farklı eşiklerle çalışır.
 */
export class MemoryLoginRateLimiter implements LoginRateLimiter {
  readonly id = "memory" as const;
  private readonly windows = new Map<string, SlidingWindowRateLimiter>();

  constructor(
    private readonly pepper: string,
    private readonly defaults: RateLimitSettings = DEFAULT_RATE_LIMIT_SETTINGS,
    private readonly now?: () => number,
  ) {}

  private hash(key: string): string {
    return hashRateLimitKey(key, this.pepper);
  }

  private windowFor(settings: RateLimitSettings): SlidingWindowRateLimiter {
    const id = `${settings.maxAttempts}|${settings.windowMs}|${settings.baseLockMs}|${settings.maxLockMs}`;
    let window = this.windows.get(id);
    if (!window) {
      window = new SlidingWindowRateLimiter({ ...settings, now: this.now });
      this.windows.set(id, window);
    }
    return window;
  }

  async check(key: string, settings = this.defaults): Promise<RateLimitDecision> {
    return this.windowFor(settings).check(this.hash(key));
  }

  async recordFailure(key: string, settings = this.defaults): Promise<RateLimitDecision> {
    return this.windowFor(settings).recordFailure(this.hash(key));
  }

  async reset(key: string): Promise<void> {
    const hashed = this.hash(key);
    for (const window of this.windows.values()) window.reset(hashed);
  }

  /** Testler için. */
  clear(): void {
    for (const window of this.windows.values()) window.clear();
  }
}
