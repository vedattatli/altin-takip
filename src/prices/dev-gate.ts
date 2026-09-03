import { TEST_OVERRIDE_TOKEN } from "@/auth/types";
import { flagFromEnv, stringFromEnv } from "@/lib/env";

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

/** Bilinen ürün ortamları. Tanımsız değer HİÇBİRİ sayılır (fail closed). */
export const DEPLOYMENT_ENVS = ["development", "test", "private-pilot", "public-production", "production"] as const;

export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number] | "unknown";

/**
 * Ürün ortamı. `APP_DEPLOYMENT_ENV` bilinen bir değer değilse "unknown" döner
 * ve deneysel kaynak kapalı kalır — yazım hatası kaynağı açmaz.
 */
export function deploymentEnv(): DeploymentEnv {
  const raw = stringFromEnv("APP_DEPLOYMENT_ENV", "").toLowerCase();
  return (DEPLOYMENT_ENVS as readonly string[]).includes(raw) ? (raw as DeploymentEnv) : "unknown";
}

/** Gerçek üretim dağıtımı mı? (Hiçbir test override'ı burada geçerli değildir.) */
export function productionDeployment(): boolean {
  const vercel = stringFromEnv("VERCEL_ENV", "").toLowerCase();
  if (vercel === "production") return true;
  const env = deploymentEnv();
  return env === "production" || env === "public-production";
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
 * DENEYSEL EKRAN KAYNAĞININ ÖZEL PİLOT KAPISI
 *
 * Ürün kararı: bu kaynak HERKESE AÇIK üretimde asla çalışmaz, ama ayrı bir
 * "özel pilot" ortamında açıkça etkinleştirilebilir.
 *
 * Kapı üç anahtarın HEPSİNİ ister:
 *
 *   APP_DEPLOYMENT_ENV=private-pilot
 *   PRICE_EXPERIMENTAL_SARRAF_SCREEN=true
 *   PRICE_EXPERIMENTAL_PRIVATE_PILOT=true
 *
 * `VERCEL_ENV=production` TEK BAŞINA engellemez: barındırma hedefi "production"
 * olsa bile ürün ortamı özel pilot olabilir. Ayrım barındırıcıya değil, açıkça
 * beyan edilen ürün ortamına dayanır.
 *
 * Fail closed: `APP_DEPLOYMENT_ENV` tanımsız, tanınmayan, `production` veya
 * `public-production` ise kaynak KAPALIDIR. İki bayraktan biri eksikse yine
 * kapalıdır — tek bir değişkenin yanlışlıkla açık kalması yetmez.
 *
 * Bu kapı erişim izni DEĞİLDİR: kaynak açık olsa bile hangi portföyün
 * kullanabileceği yöneticinin izin listesiyle ayrıca belirlenir ve veritabanı
 * kısıtı kaynağın genel kullanıcı listesine çıkmasını engeller.
 */
export function experimentalScreenAllowed(): boolean {
  if (deploymentEnv() !== "private-pilot") return false;
  if (!flagFromEnv("PRICE_EXPERIMENTAL_SARRAF_SCREEN")) return false;
  return flagFromEnv("PRICE_EXPERIMENTAL_PRIVATE_PILOT");
}

/** Kaynağın neden kapalı olduğunu yöneticiye anlatır. */
export function experimentalScreenBlockReason(): string | null {
  if (experimentalScreenAllowed()) return null;
  const env = deploymentEnv();
  if (env !== "private-pilot") {
    return `Deneysel ekran kaynağı yalnızca özel pilot ortamında çalışır (APP_DEPLOYMENT_ENV=private-pilot; şu an: ${env}).`;
  }
  if (!flagFromEnv("PRICE_EXPERIMENTAL_SARRAF_SCREEN")) {
    return "PRICE_EXPERIMENTAL_SARRAF_SCREEN=true değil.";
  }
  return "PRICE_EXPERIMENTAL_PRIVATE_PILOT=true değil.";
}
