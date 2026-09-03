/**
 * TEST ORTAMI SABİTLERİ
 *
 * Bu değerler GERÇEK SECRET DEĞİLDİR; yalnızca yerel Playwright sunucusu için
 * sabit test değerleridir ve üretimde kullanılmaz.
 *
 * Tek yerde tanımlanır çünkü hem sunucu süreci (playwright.config webServer.env)
 * hem de test süreci (yardımcılar) aynı değeri kullanmak zorundadır. Playwright
 * çalıştırıcısı webServer.env değişkenlerini KENDİ sürecine yazmaz.
 */

/** Yönetici TOTP anahtarının AES-256-GCM şifreleme anahtarı (32 bayt, base64). */
export const E2E_MFA_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

/** Zamanlanmış fiyat alımı ve sağlık ayrıntısı için paylaşılan secret. */
export const E2E_CRON_SECRET = "e2e-cron-secret-gercek-degil";
