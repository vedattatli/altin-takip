/**
 * Giriş denemeleri için kayan pencere + artan bekleme (backoff) sınırlayıcı.
 *
 * Sunucu belleğinde tutulur. Tek örnekli (single instance) dağıtımlar için
 * yeterlidir; çok örnekli üretim dağıtımında paylaşımlı bir depoya
 * (Redis / Postgres) taşınmalıdır — bkz. docs/SECURITY.md.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Kalan deneme hakkı. */
  remaining: number;
  /** Engelliyse tekrar denenebilecek zamana kalan süre (ms). */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Pencere içinde izin verilen başarısız deneme sayısı. */
  maxAttempts?: number;
  /** Pencere uzunluğu (ms). */
  windowMs?: number;
  /** Sınır aşıldığında ilk bekleme süresi (ms). Her tekrarda ikiye katlanır. */
  baseLockMs?: number;
  /** En uzun bekleme süresi (ms). */
  maxLockMs?: number;
  now?: () => number;
}

interface Bucket {
  failures: number[];
  lockedUntil: number;
  lockLevel: number;
}

export class LoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.baseLockMs = options.baseLockMs ?? 60 * 1000;
    this.maxLockMs = options.maxLockMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  private bucket(key: string): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { failures: [], lockedUntil: 0, lockLevel: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private prune(bucket: Bucket, timestamp: number): void {
    const cutoff = timestamp - this.windowMs;
    bucket.failures = bucket.failures.filter((at) => at > cutoff);
  }

  /** Denemeye izin verilip verilmediğini söyler; sayaç ARTIRMAZ. */
  check(key: string): RateLimitDecision {
    const timestamp = this.now();
    const bucket = this.bucket(key);
    this.prune(bucket, timestamp);

    if (bucket.lockedUntil > timestamp) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.lockedUntil - timestamp };
    }
    return {
      allowed: true,
      remaining: Math.max(0, this.maxAttempts - bucket.failures.length),
      retryAfterMs: 0,
    };
  }

  /** Başarısız denemeyi kaydeder ve gerekiyorsa bekleme uygular. */
  recordFailure(key: string): RateLimitDecision {
    const timestamp = this.now();
    const bucket = this.bucket(key);
    this.prune(bucket, timestamp);
    bucket.failures.push(timestamp);

    if (bucket.failures.length >= this.maxAttempts) {
      bucket.lockLevel += 1;
      const lockMs = Math.min(this.baseLockMs * 2 ** (bucket.lockLevel - 1), this.maxLockMs);
      bucket.lockedUntil = timestamp + lockMs;
      bucket.failures = [];
      return { allowed: false, remaining: 0, retryAfterMs: lockMs };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxAttempts - bucket.failures.length),
      retryAfterMs: 0,
    };
  }

  /** Başarılı girişte sayaç sıfırlanır. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Testler için. */
  clear(): void {
    this.buckets.clear();
  }
}

export function formatRetryAfter(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60) return `${seconds} saniye`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} dakika`;
}
