import "server-only";

import { createClient } from "@supabase/supabase-js";

import { misconfigured } from "@/server/auth/errors";
import { hasSupabaseConfig, serverEnv } from "@/server/env";
import { MemoryLoginRateLimiter } from "./memory";
import { PostgresLoginRateLimiter } from "./postgres";
import type { LoginRateLimiter } from "./types";

export * from "./types";
export { MemoryLoginRateLimiter } from "./memory";
export { PostgresLoginRateLimiter } from "./postgres";

/** Geliştirmede pepper zorunlu tutulmaz; sabit bir geliştirme değeri kullanılır. */
const DEV_PEPPER = "gelistirme-ortami-pepper-degeri";

let cached: LoginRateLimiter | null = null;

/**
 * Aktif hız sınırlayıcıyı seçer.
 *
 * KURAL: üretimde paylaşımlı (Postgres) sınırlayıcı ZORUNLUDUR. Yapılandırma
 * eksikse sessizce bellek sınırlayıcısına DÜŞÜLMEZ; açık bir yapılandırma
 * hatası verilir (fail closed).
 */
export function createLoginRateLimiter(): LoginRateLimiter {
  // Otomatik testler üretim derlemesine karşı koşar; aynı açık kaçış kapısı
  // (AUTH_ALLOW_LOCAL_BACKEND) orada da geçerlidir. Üretim dağıtımlarında
  // bu değişken ASLA ayarlanmaz.
  const testEscapeHatch = serverEnv.allowLocalBackendInProduction;

  if (serverEnv.isProduction && !testEscapeHatch) {
    if (!hasSupabaseConfig()) {
      throw misconfigured(
        "Üretimde paylaşımlı hız sınırlayıcı için Supabase yapılandırması zorunludur.",
      );
    }
    if (!serverEnv.rateLimitPepper) {
      throw misconfigured(
        "RATE_LIMIT_PEPPER tanımlı değil. Üretimde hız sınırlayıcı anahtarları gizlenmeden çalıştırılamaz.",
      );
    }
    const client = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return new PostgresLoginRateLimiter(client, serverEnv.rateLimitPepper);
  }

  // Geliştirme/test: Supabase varsa yine paylaşımlı sınırlayıcı tercih edilir.
  if (hasSupabaseConfig() && serverEnv.rateLimitPepper) {
    const client = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return new PostgresLoginRateLimiter(client, serverEnv.rateLimitPepper);
  }

  return new MemoryLoginRateLimiter(serverEnv.rateLimitPepper || DEV_PEPPER);
}

export function getLoginRateLimiter(): LoginRateLimiter {
  if (!cached) cached = createLoginRateLimiter();
  return cached;
}
