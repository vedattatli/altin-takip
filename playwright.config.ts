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
      name: "tablet-768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
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
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: testEnv,
    stdout: "ignore",
    stderr: "pipe",
  },
});
