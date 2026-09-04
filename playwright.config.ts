import { defineConfig, devices } from "@playwright/test";

import { E2E_CRON_SECRET, E2E_MFA_ENCRYPTION_KEY } from "./e2e/test-env";
import { TEST_OVERRIDE_TOKEN as PRICE_TEST_TOKEN } from "./src/auth/types";

/**
 * Tarayıcı duman (smoke) testleri.
 *
 * Testler ÜRETİM DERLEMESİNE karşı çalışır (`next build` + `next start`), böylece
 * kullanıcıya gidecek olan kodun tam olarak aynısı doğrulanır.
 *
 * Supabase olmadan çalışabilmek için yerel kimlik doğrulama arka ucu açık test
 * kaçış kapısıyla (AUTH_ALLOW_LOCAL_BACKEND) etkinleştirilir. Bu değişken üretim
 * dağıtımlarında ASLA ayarlanmaz; ayarlanmadığında üretim derlemesi Supabase
 * yapılandırması ister ve yerel arka uç çalışmaz.
 *
 * Testler kendi veri dosyasını kullanır (.data/auth-e2e.json), böylece
 * geliştiricinin yerel hesapları etkilenmez.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Kaçış kapısı belirteci — src/auth/types.ts içindeki TEST_OVERRIDE_TOKEN ile aynı. */
const TEST_OVERRIDE_TOKEN = "yalnizca-test-icin";

const testEnv = {
  AUTH_LOCAL_STORE_FILE: "auth-e2e.json",
  // Geliştiricinin `.env.local` dosyası bu takımı SESSİZCE geçersizleştirmesin.
  //
  // Next.js `.env.local` değerlerini sunucu açılışında yükler ama zaten ayarlı
  // ortam değişkenlerini EZMEZ. Bu yüzden Supabase anahtarlarını burada boşa
  // çekiyoruz: aksi hâlde `.env.local` içinde Supabase yapılandırması bulunan
  // bir makinede uygulama Supabase arka ucuna geçer, E2E yöneticisi orada
  // bulunmaz ve bütün girişler "kullanıcı adı veya parola hatalı" verir.
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SECRET_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  // Supabase olmadan üretim derlemesini test edebilmek için.
  AUTH_ALLOW_LOCAL_BACKEND: TEST_OVERRIDE_TOKEN,
  // Yalnızca yerel test sunucusu için sabit değerler. GERÇEK SECRET DEĞİLDİR;
  // üretimde bu değişkenler güvenli rastgele değerlerle ayarlanır.
  AUTH_CSRF_SECRET: "e2e-test-ortami-sabit-degeri-gercek-secret-degil",
  RATE_LIMIT_PEPPER: "e2e-test-ortami-sabit-degeri-gercek-secret-degil",
  // Üretim derlemesinde APP_ORIGIN zorunludur; test sunucusunun adresi.
  APP_ORIGIN: "http://127.0.0.1:3100",
  // Test sunucusu doğrudan dinler; X-Forwarded-For yerel kabul edilir.
  TRUSTED_PROXY_PROVIDER: "local",
  // Test sağlayıcısı bu ürünler için fiyat ÜRETMEZ: "hiç fiyat yok" ve "kısmi" durumları uçtan uca test edilir.
  PRICE_MOCK_UNAVAILABLE_PRODUCTS: "resat-altin,hamit-altin",
  // Yönetici ikinci faktörü için şifreleme anahtarı. GERÇEK SECRET DEĞİLDİR; yalnızca test.
  AUTH_MFA_ENCRYPTION_KEY: E2E_MFA_ENCRYPTION_KEY,
  // Zamanlanmış fiyat alımı ucu için test secret'ı.
  PRICE_CRON_SECRET: E2E_CRON_SECRET,
  // Test verisi sağlayıcısı için AYRI kapı. Yerel auth kapısından bağımsızdır ve
  // gerçek üretim dağıtımında (VERCEL_ENV=production) hiçbir etkisi yoktur.
  PRICE_ALLOW_MOCK_PROVIDER: PRICE_TEST_TOKEN,
  // --- `.env.local` SIZINTISINA KARŞI TAM SABİTLEME ---
  //
  // Next.js `.env.local` dosyasını sunucu açılışında yükler ama zaten ayarlı
  // ortam değişkenlerini EZMEZ. Bu yüzden takımın davrandığı her değişken
  // burada AÇIKÇA sabitlenir. Aksi hâlde geliştiricinin makinesindeki
  // `.env.local` testleri sessizce değiştirir: bu gerçekten yaşandı —
  // `AUTH_SESSION_COOKIE` sızdı ve oturum çerezi testleri çerezi bulamadı.
  //
  // `tests/deployment-surface.test.ts` bu listenin `.env.example` ile
  // eksiksiz örtüştüğünü denetler; yeni bir değişken eklenince test kırılır.
  AUTH_SESSION_COOKIE: "altin_takip_session",
  APP_DEPLOYMENT_ENV: "test",
  AUTH_INTERNAL_EMAIL_DOMAIN: "e2e.invalid",
  PRICE_EXPERIMENTAL_SARRAF_SCREEN: "false",
  PRICE_EXPERIMENTAL_PRIVATE_PILOT: "false",
  BACKUP_ENCRYPTION_KEY: "",
  BACKUP_CRON_SECRET: "",
  NEXT_PUBLIC_ENABLE_DEMO_MODE: "false",
  // Bu değişkenler E2E'de KULLANILMAZ; boş bırakılır ki canlı bir
  // sağlayıcıya veya gerçek bir yapılandırmaya düşülmesin.
  PRICE_INGESTION_INTERVAL_MS: "",
  PRICE_STALE_AFTER_MS: "",
  PRICE_MAX_CHANGE_RATIO: "",
  PRICE_MAX_SPREAD_RATIO: "",
  PRICE_MIN_TRY: "",
  PRICE_MAX_TRY: "",
  ALTINAPI_CONTRACT_VERSION: "",
  HASFIYAT_CONTRACT_VERSION: "",
  SARRAFPRO_CONTRACT_VERSION: "",
  SARRAFPRO_API_URL: "",
  SARRAFPRO_API_KEY: "",
  SARRAFPRO_MARKET_ID: "",
  SARRAFPRO_LICENSE_REFERENCE: "",
  SARRAFPRO_REDISTRIBUTION_ALLOWED: "",
  ALTINAPI_API_URL: "",
  ALTINAPI_API_KEY: "",
  ALTINAPI_LICENSE_TIER: "",
  ALTINAPI_REDISTRIBUTION_ALLOWED: "",
  HASFIYAT_API_URL: "",
  HASFIYAT_API_KEY: "",
  HASFIYAT_SOURCE: "",
  HASFIYAT_LICENSE_REFERENCE: "",
  HASFIYAT_REDISTRIBUTION_ALLOWED: "",
};

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Testler ortak yerel veri dosyasını paylaştığı için sıralı çalışır.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "mobil-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      // Tablet/küçük masaüstü. 1024 px, iki sütunlu panel düzeninin ALT
      // eşiğidir: bu genişlikte panel dashboard'un altına iner ve kartlar
      // sıkışmaz. Kırılım davranışı tam burada sınanır.
      name: "tablet-1024",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } },
    },
    {
      name: "masaustu-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: {
    // Üretim derlemesi: geliştirme sunucusunun HMR istemcisi devrede olmaz.
    command: `npx next build && npx next start --port ${PORT}`,
    url: BASE_URL,
    // KASITLI OLARAK KAPALI.
    //
    // Sunucu yeniden kullanılırsa Playwright `env` bloğunu UYGULAMAZ: 3100
    // portunda önceden çalışan bir sunucu devralınır ve testEnv hiç geçerli
    // olmaz. Bu, 282 testin sessizce geçersiz koşmasına yol açtı (yönetici
    // girişleri baştan sona başarısız oldu, çünkü sunucu E2E veri dosyasını
    // kullanmıyordu). Her koşum kendi sunucusunu başlatır.
    reuseExistingServer: false,
    timeout: 300_000,
    env: testEnv,
    stdout: "ignore",
    stderr: "pipe",
  },
});
