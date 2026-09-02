import { defineConfig, devices } from "@playwright/test";

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
  // Ortak cihaz otomatik çıkışını testte beklenebilir hâle getirir.
  // Bu iki değişken olmadan süre her zaman 15 dakikadır.
  NEXT_PUBLIC_ALLOW_TEST_OVERRIDES: TEST_OVERRIDE_TOKEN,
  NEXT_PUBLIC_SHARED_IDLE_MS: "5000",
  // Yalnızca yerel test sunucusu için sabit değerler. GERÇEK SECRET DEĞİLDİR;
  // üretimde bu değişkenler güvenli rastgele değerlerle ayarlanır.
  AUTH_CSRF_SECRET: "e2e-test-ortami-sabit-degeri-gercek-secret-degil",
  RATE_LIMIT_PEPPER: "e2e-test-ortami-sabit-degeri-gercek-secret-degil",
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
