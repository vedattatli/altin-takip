import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

/**
 * Gerçek staging E2E (Vercel staging URL'si + Supabase staging projesi).
 *
 *   npm run test:staging
 *
 * - Sunucu başlatılmaz; STAGING_BASE_URL (.env.staging.local) hedef alınır.
 * - Kimlik bilgileri .staging/accounts.local.json dosyasından okunur (gitignore).
 * - Mobil 390 px ve masaüstü 1440 px bağlamları.
 */
loadEnv({ path: ".env.staging.local", quiet: true });

const BASE_URL = (process.env.STAGING_BASE_URL ?? "").trim().replace(/\/+$/, "");
if (!BASE_URL) {
  throw new Error("STAGING_BASE_URL tanımlı değil (.env.staging.local). Staging E2E çalıştırılmadı.");
}
if (!/^https:\/\//.test(BASE_URL) || /localhost|127\.0\.0\.1/.test(BASE_URL)) {
  throw new Error("STAGING_BASE_URL https:// ile başlayan uzak bir staging adresi olmalıdır.");
}

export default defineConfig({
  testDir: "./e2e-staging",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "mobil-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "masaustu-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
});
