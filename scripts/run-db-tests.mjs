/**
 * RLS veritabanı testlerini çalıştırır (pgTAP).
 *
 *   npm run test:db
 *
 * Supabase CLI ve Docker gerektirir. Ortam uygun değilse testler
 * ÇALIŞTIRILMIŞ GİBİ RAPORLANMAZ: durum açıkça yazılır ve çıkış kodu 2 olur
 * (0 = geçti, 1 = başarısız, 2 = çalıştırılamadı).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const TEST_DIR = "supabase/tests";

function has(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" });
  return result.status === 0;
}

if (!existsSync(TEST_DIR)) {
  console.error(`Test klasörü bulunamadı: ${TEST_DIR}`);
  process.exit(2);
}

const files = readdirSync(TEST_DIR).filter((file) => file.endsWith(".sql"));
console.log(`RLS test dosyaları: ${files.join(", ") || "(yok)"}`);

if (!has("supabase", ["--version"])) {
  console.error("");
  console.error("ATLANDI: Supabase CLI bulunamadı; RLS testleri ÇALIŞTIRILMADI.");
  console.error("Kurulum: https://supabase.com/docs/guides/cli");
  console.error("Ardından: supabase start && npm run test:db");
  process.exit(2);
}

if (!has("docker", ["info"])) {
  console.error("");
  console.error("ATLANDI: Docker çalışmıyor; RLS testleri ÇALIŞTIRILMADI.");
  console.error("Supabase yerel yığını Docker gerektirir.");
  process.exit(2);
}

const result = spawnSync("supabase", ["test", "db"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
