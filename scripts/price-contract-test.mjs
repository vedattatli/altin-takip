/**
 * Sağlayıcı sözleşme testleri.
 *
 *   npm run price:contract
 *
 * Fixture ile çalışır; GERÇEK API anahtarı gerektirmez ve hiçbir dış servise
 * bağlanmaz. Canlı entegrasyon ayrıdır: credential yoksa NOT_RUN raporlanır ve
 * hiçbir koşulda "geçti" denmez.
 */
import { spawnSync } from "node:child_process";

const shell = process.platform === "win32";

const LIVE_PROVIDERS = [
  { code: "sarraf-pro-kayseri", env: ["SARRAFPRO_API_URL", "SARRAFPRO_API_KEY", "SARRAFPRO_MARKET_ID", "SARRAFPRO_LICENSE_REFERENCE", "SARRAFPRO_REDISTRIBUTION_ALLOWED"] },
  { code: "altinapi", env: ["ALTINAPI_API_URL", "ALTINAPI_API_KEY", "ALTINAPI_LICENSE_TIER", "ALTINAPI_REDISTRIBUTION_ALLOWED"] },
  { code: "hasfiyat", env: ["HASFIYAT_API_URL", "HASFIYAT_API_KEY", "HASFIYAT_LICENSE_REFERENCE", "HASFIYAT_REDISTRIBUTION_ALLOWED"] },
];

console.log("== Sağlayıcı sözleşme testleri (fixture) ==");
const result = spawnSync("npx", ["vitest", "run", "tests/price-providers.test.ts", "tests/price-sources.test.ts"], {
  stdio: "inherit",
  shell,
});

console.log("");
console.log("== Canlı sağlayıcı entegrasyonu ==");
let anyLive = false;
for (const provider of LIVE_PROVIDERS) {
  const missing = provider.env.filter((name) => (process.env[name] ?? "").trim() === "");
  const redistribution = provider.env.find((name) => name.endsWith("REDISTRIBUTION_ALLOWED"));
  const licensed = redistribution ? (process.env[redistribution] ?? "").toLowerCase() === "true" : false;
  if (missing.length > 0) {
    // Eksik DEĞİŞKEN ADLARI yazılır; değer ASLA yazılmaz.
    console.log(`  NOT_RUN  ${provider.code} — eksik ayar: ${missing.join(", ")}`);
    continue;
  }
  if (!licensed) {
    console.log(`  NOT_RUN  ${provider.code} — yeniden gösterim izni işaretlenmemiş (${redistribution})`);
    continue;
  }
  anyLive = true;
  console.log(`  HAZIR    ${provider.code} — canlı test için yapılandırma tamam.`);
}
if (!anyLive) {
  console.log("");
  console.log("Canlı sağlayıcı testi ÇALIŞTIRILMADI: lisanslı credential yok.");
  console.log("Bu bir başarısızlık değildir; gerçek veri başarısı İDDİA EDİLMEZ.");
}

process.exit(result.status ?? 1);
