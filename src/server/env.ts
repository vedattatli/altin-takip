import "server-only";

import { TEST_OVERRIDE_TOKEN } from "@/auth/types";

/**
 * Sunucu ortam değişkenleri.
 *
 * Bu modül "server-only" işaretlidir; istemci paketine dâhil edilemez.
 * SUPABASE_SERVICE_ROLE_KEY burada okunur ve HİÇBİR ZAMAN istemciye gönderilmez.
 */

export type AuthBackendId = "supabase" | "local";

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const serverEnv = {
  supabaseUrl: read("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  /** Yalnızca sunucuda. İstemciye sızmadığı testle doğrulanır. */
  supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  /**
   * Kullanıcı adından türetilen dahili kimliğin alan adı.
   * Bu adrese asla e-posta gönderilmez; yalnızca Supabase Auth'un
   * gerektirdiği benzersiz kimlik alanını doldurur.
   */
  internalEmailDomain: read("AUTH_INTERNAL_EMAIL_DOMAIN") || "users.altin-takip.invalid",
  sessionCookieName: read("AUTH_SESSION_COOKIE") || "altin_takip_session",
  sessionTtlHours: Number(read("AUTH_SESSION_TTL_HOURS") || "336"),
  isProduction: process.env.NODE_ENV === "production",
  /**
   * Yerel geliştirme arka ucunun üretim derlemesinde çalışmasına izin verir.
   * YALNIZCA otomatik testler içindir; üretim dağıtımlarında ayarlanmaz.
   */
  allowLocalBackendInProduction: read("AUTH_ALLOW_LOCAL_BACKEND") === TEST_OVERRIDE_TOKEN,
  /** Demo modu yalnızca geliştirme ortamında ve açıkça etkinleştirilirse çalışır. */
  demoModeEnabled:
    process.env.NODE_ENV !== "production" && read("NEXT_PUBLIC_ENABLE_DEMO_MODE") === "true",
} as const;

export function hasSupabaseConfig(): boolean {
  return Boolean(
    serverEnv.supabaseUrl && serverEnv.supabaseAnonKey && serverEnv.supabaseServiceRoleKey,
  );
}

/**
 * Aktif kimlik doğrulama arka ucu.
 *
 * - Supabase bilgileri tamsa "supabase".
 * - Değilse geliştirme ortamında "local" (yalnızca geliştirme için test arka ucu).
 * - Üretimde Supabase bilgileri eksikse hata verilir; sahte bir arka uçla
 *   gerçek kullanıcı varmış gibi davranılmaz.
 */
export function resolveAuthBackendId(): AuthBackendId {
  if (hasSupabaseConfig()) return "supabase";
  if (serverEnv.isProduction && !serverEnv.allowLocalBackendInProduction) {
    throw new Error(
      "Supabase yapılandırması eksik. Üretim ortamında NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY ve SUPABASE_SERVICE_ROLE_KEY zorunludur.",
    );
  }
  return "local";
}

/** İstemciye güvenle gönderilebilecek yapılandırma özeti. */
export interface PublicRuntimeConfig {
  backend: AuthBackendId;
  backendLabel: string;
  /** Arka uç gerçek bir bulut hesabı mı yönetiyor? */
  isCloudBackend: boolean;
  demoModeEnabled: boolean;
}

export function publicRuntimeConfig(): PublicRuntimeConfig {
  const backend = resolveAuthBackendId();
  return {
    backend,
    backendLabel:
      backend === "supabase" ? "Supabase" : "Yerel geliştirme sunucusu (Supabase değil)",
    isCloudBackend: backend === "supabase",
    demoModeEnabled: serverEnv.demoModeEnabled,
  };
}
