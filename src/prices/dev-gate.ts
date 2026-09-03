import { TEST_OVERRIDE_TOKEN } from "@/auth/types";

/**
 * TEST VERİSİ SAĞLAYICISININ ÜRETİM KAPISI
 *
 * Test sağlayıcısı gerçek kullanıcıya asla fiyat üretmemelidir. Kapı üç
 * kademelidir ve en katı olan kazanır:
 *
 *  1. GERÇEK ÜRETİM DAĞITIMI (`VERCEL_ENV=production` veya
 *     `APP_DEPLOYMENT_ENV=production`): test sağlayıcısı HİÇBİR override ile
 *     açılamaz. Bu kademe bilinçli olarak koşulsuzdur.
 *  2. Üretim DERLEMESİ (`NODE_ENV=production`) ama üretim dağıtımı değil:
 *     yalnızca test koşucusunun ayarladığı `PRICE_ALLOW_MOCK_PROVIDER`
 *     belirteciyle açılır. Playwright paketi üretim derlemesine karşı koştuğu
 *     için bu kapı gereklidir.
 *  3. Geliştirme: açıktır.
 *
 * Bu kapı, yerel auth arka ucunu açan `AUTH_ALLOW_LOCAL_BACKEND` kapısından
 * AYRIDIR. Daha önce ikisi aynı anahtara bağlıydı; tek bir değişken iki farklı
 * güvenlik kararını birden açıyordu. Artık test fiyatı için ayrı ve açık bir
 * belirteç gerekir.
 */

/** Gerçek üretim dağıtımı mı? (Hiçbir test override'ı burada geçerli değildir.) */
export function productionDeployment(): boolean {
  const vercel = (process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercel === "production") return true;
  return (process.env.APP_DEPLOYMENT_ENV ?? "").trim().toLowerCase() === "production";
}

/** Yalnızca test koşucusunun ayarlayabileceği açık test verisi belirteci. */
export function mockProviderOverrideActive(): boolean {
  return process.env.PRICE_ALLOW_MOCK_PROVIDER === TEST_OVERRIDE_TOKEN;
}

/** Test verisi sağlayıcısı bu ortamda kullanılamaz mı? */
export function devOnlyProviderBlocked(): boolean {
  // 1. Üretim dağıtımında koşulsuz kapalı.
  if (productionDeployment()) return true;
  // 3. Geliştirme ortamında açık.
  if (process.env.NODE_ENV !== "production") return false;
  // 2. Üretim derlemesi: yalnızca açık test belirteciyle.
  return !mockProviderOverrideActive();
}

export const DEV_ONLY_BLOCKED_MESSAGE = "Test verisi sağlayıcısı üretim ortamında kullanılamaz.";

/**
 * DENEYSEL EKRAN KAYNAĞI KAPISI
 *
 * `PRICE_EXPERIMENTAL_SARRAF_SCREEN=true` olmadan kaynak hiç çalışmaz.
 * Gerçek üretim dağıtımında (VERCEL_ENV=production veya
 * APP_DEPLOYMENT_ENV=production) bayrak YOK SAYILIR: deneysel ekran gözlemi
 * genel kullanıcıya asla fiyat üretmez.
 *
 * Bayrak açık olsa bile bu, kaynağın herkese açıldığı anlamına GELMEZ; hangi
 * portföyün kullanabileceği yöneticinin izin listesiyle ayrıca belirlenir.
 */
export function experimentalScreenAllowed(): boolean {
  if (productionDeployment()) return false;
  return (process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN ?? "").trim().toLowerCase() === "true";
}
