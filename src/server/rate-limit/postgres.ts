import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { hashRateLimitKey } from "./key";
import {
  DEFAULT_RATE_LIMIT_SETTINGS,
  type LoginRateLimiter,
  type RateLimitDecision,
  type RateLimitSettings,
} from "./types";

/**
 * Postgres tabanlı paylaşımlı hız sınırlayıcı.
 *
 * Birden çok Next.js/Vercel örneği aynı sayaç üzerinde çalışır. Sayaç
 * güncellemeleri tek bir atomik SQL fonksiyonu içinde yapılır
 * (bkz. supabase/migrations/0005_security_hardening.sql), böylece eşzamanlı
 * denemeler sınırı aşamaz.
 *
 * Tabloda ham IP veya kullanıcı adı TUTULMAZ; yalnızca peppered HMAC özeti.
 */
export class PostgresLoginRateLimiter implements LoginRateLimiter {
  readonly id = "postgres" as const;

  constructor(
    private readonly client: SupabaseClient,
    private readonly pepper: string,
    private readonly settings: RateLimitSettings = DEFAULT_RATE_LIMIT_SETTINGS,
  ) {}

  private hash(key: string): string {
    return hashRateLimitKey(key, this.pepper);
  }

  private toDecision(row: unknown): RateLimitDecision {
    const record = (row ?? {}) as {
      allowed?: boolean;
      remaining?: number;
      retry_after_ms?: number;
    };
    return {
      allowed: record.allowed ?? false,
      remaining: record.remaining ?? 0,
      retryAfterMs: record.retry_after_ms ?? 0,
    };
  }

  private params(keyHash: string): Record<string, unknown> {
    return {
      p_key_hash: keyHash,
      p_max_attempts: this.settings.maxAttempts,
      p_window_ms: this.settings.windowMs,
      p_base_lock_ms: this.settings.baseLockMs,
      p_max_lock_ms: this.settings.maxLockMs,
    };
  }

  async check(key: string): Promise<RateLimitDecision> {
    const { data, error } = await this.client.rpc(
      "login_rate_limit_check",
      this.params(this.hash(key)),
    );
    if (error) {
      // Sınırlayıcı çalışmıyorsa AÇIK KALINMAZ: istek reddedilir.
      throw new Error(`Hız sınırlayıcı okunamadı: ${error.message}`);
    }
    return this.toDecision(Array.isArray(data) ? data[0] : data);
  }

  async recordFailure(key: string): Promise<RateLimitDecision> {
    const { data, error } = await this.client.rpc(
      "login_rate_limit_record_failure",
      this.params(this.hash(key)),
    );
    if (error) {
      throw new Error(`Hız sınırlayıcı güncellenemedi: ${error.message}`);
    }
    return this.toDecision(Array.isArray(data) ? data[0] : data);
  }

  async reset(key: string): Promise<void> {
    const { error } = await this.client.rpc("login_rate_limit_reset", {
      p_key_hash: this.hash(key),
    });
    if (error) throw new Error(`Hız sınırlayıcı sıfırlanamadı: ${error.message}`);
  }
}
