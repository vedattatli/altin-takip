import { TEST_OVERRIDE_TOKEN } from "@/auth/types";

/**
 * TEST VERİSİ SAĞLAYICISININ ÜRETİM KAPISI
 *
 * Test sağlayıcısı gerçek kullanıcıya asla fiyat üretmemelidir. Kural:
 * `NODE_ENV=production` ise kapalıdır.
 *
 * Tek istisna, uygulamanın zaten var olan test kaçış kapısıdır
 * (`AUTH_ALLOW_LOCAL_BACKEND`). Playwright paketi ÜRETİM DERLEMESİNE karşı
 * çalıştırır; o ortamda yerel arka uç bu belirteçle açılır. Belirteç gerçek
 * dağıtımlarda ASLA ayarlanmaz — ayarlanmadığında hem yerel arka uç hem test
 * sağlayıcısı kapalıdır. Böylece tek bir anahtar iki kapıyı birlikte yönetir ve
 * üretim güvenliği zayıflamaz.
 */
export function testBackendOverrideActive(): boolean {
  return process.env.AUTH_ALLOW_LOCAL_BACKEND === TEST_OVERRIDE_TOKEN;
}

/** Test verisi sağlayıcısı bu ortamda kullanılamaz mı? */
export function devOnlyProviderBlocked(): boolean {
  return process.env.NODE_ENV === "production" && !testBackendOverrideActive();
}

export const DEV_ONLY_BLOCKED_MESSAGE = "Test verisi sağlayıcısı üretim ortamında kullanılamaz.";
