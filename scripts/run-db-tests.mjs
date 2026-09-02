/**
 * Veritabanı yetki ve RLS testlerini çalıştırır (pgTAP).
 *
 *   npm run test:db
 *
 * Supabase CLI ve Docker gerektirir. Ortam uygun değilse testler
 * ÇALIŞTIRILMIŞ GİBİ RAPORLANMAZ: durum açıkça yazılır ve çıkış kodu 2 olur
 * (0 = geçti, 1 = başarısız, 2 = çalıştırılamadı).
 *
 * Akış: `supabase db reset` ile 0001'den itibaren TÜM migration'lar temiz bir
 * veritabanına uygulanır, ardından `supabase test db` pgTAP dosyalarını koşar.
 * `--no-reset` verilirse yalnızca testler çalışır.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const TEST_DIR = "supabase/tests";
const shell = process.platform === "win32";
const skipReset = process.argv.includes("--no-reset");

function run(command, args, stdio = "ignore") {
  return spawnSync(command, args, { stdio, shell });
}

/** Önce PATH'teki `supabase`, yoksa proje bağımlılığı üzerinden `npx supabase`. */
function resolveCli() {
  if (run("supabase", ["--version"]).status === 0) return ["supabase", []];
  if (run("npx", ["--no-install", "supabase", "--version"]).status === 0) {
    return ["npx", ["--no-install", "supabase"]];
  }
  return null;
}

if (!existsSync(TEST_DIR)) {
  console.error(`Test klasörü bulunamadı: ${TEST_DIR}`);
  process.exit(2);
}

const files = readdirSync(TEST_DIR).filter((file) => file.endsWith(".sql"));
console.log(`pgTAP test dosyaları: ${files.join(", ") || "(yok)"}`);

const cli = resolveCli();
if (!cli) {
  console.error("");
  console.error("ATLANDI: Supabase CLI bulunamadı; veritabanı testleri ÇALIŞTIRILMADI.");
  console.error("Kurulum: https://supabase.com/docs/guides/cli  (veya devDependency: supabase)");
  process.exit(2);
}

if (run("docker", ["info"]).status !== 0) {
  console.error("");
  console.error("ATLANDI: Docker çalışmıyor; veritabanı testleri ÇALIŞTIRILMADI.");
  console.error("Supabase yerel yığını Docker gerektirir.");
  process.exit(2);
}

const [command, prefix] = cli;

if (!skipReset) {
  console.log("Veritabanı sıfırlanıyor: 0001'den itibaren tüm migration'lar uygulanıyor...");
  const reset = run(command, [...prefix, "db", "reset"], "inherit");
  if (reset.status !== 0) {
    console.error("");
    console.error("Migration'lar temiz veritabanına uygulanamadı; testler ÇALIŞTIRILMADI.");
    process.exit(reset.status ?? 2);
  }
}

const result = run(command, [...prefix, "test", "db"], "inherit");
process.exit(result.status ?? 1);
