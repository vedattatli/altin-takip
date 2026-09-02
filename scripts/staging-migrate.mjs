/**
 * Staging migration'ları: 0001'den son migration'a kadar sırayla uygular ve
 * migration geçmişini doğrular.
 *
 *   npm run staging:migrate
 *
 * Ön koşul (kullanıcı, interaktif): npx supabase login && npx supabase link --project-ref <staging-ref>
 * Bu betik veritabanı parolası istemez ve yazdırmaz; bağlı projenin STAGING ref'i ile
 * eşleştiğini doğrular, aksi hâlde hiçbir şey yapmaz (production koruması).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { requireStagingEnv } from "./staging/env.mjs";

const shell = process.platform === "win32";
const values = requireStagingEnv();
const ref = values.SUPABASE_STAGING_PROJECT_REF.trim();

function supabase(args, options = {}) {
  return spawnSync("npx", ["--no-install", "supabase", ...args], {
    encoding: "utf8",
    shell,
    timeout: options.timeout ?? 600_000,
    input: options.input,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

const linkedFile = "supabase/.temp/project-ref";
if (!existsSync(linkedFile)) {
  console.error("Bağlı Supabase projesi yok. Kullanıcı terminalde şunu çalıştırmalı:");
  console.error(`  npx supabase login && npx supabase link --project-ref ${ref}`);
  process.exit(1);
}
const linkedRef = readFileSync(linkedFile, "utf8").trim();
if (linkedRef !== ref) {
  console.error("Bağlı proje ref'i STAGING ref'i ile uyuşmuyor; migration uygulanmadı (production koruması).");
  process.exit(1);
}
if (values.SUPABASE_PRODUCTION_PROJECT_REF && values.SUPABASE_PRODUCTION_PROJECT_REF.trim() === linkedRef) {
  console.error("Bağlı proje production ref'i; staging aracı production'a dokunmaz.");
  process.exit(1);
}

const local = readdirSync("supabase/migrations")
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()
  .map((file) => file.slice(0, 4));
console.log(`Yerel migration'lar: ${local[0]} → ${local[local.length - 1]} (${local.length} dosya)`);

console.log("Uzak staging veritabanına uygulanıyor (supabase db push --linked)...");
const push = supabase(["db", "push", "--linked", "--include-all"], { input: "y\n" });
process.stdout.write(push.stdout ?? "");
if (push.status !== 0) {
  console.error((push.stderr ?? "").split("\n").filter((line) => !/password|secret|key/i.test(line)).join("\n"));
  console.error("Migration push başarısız; staging doğrulanmadı.");
  process.exit(push.status ?? 1);
}

console.log("Migration geçmişi doğrulanıyor (supabase migration list --linked)...");
const list = supabase(["migration", "list", "--linked"]);
process.stdout.write(list.stdout ?? "");
if (list.status !== 0) {
  console.error("Migration listesi okunamadı; geçmiş doğrulanamadı.");
  process.exit(list.status ?? 1);
}
const missing = local.filter((version) => {
  const row = (list.stdout ?? "").split("\n").find((line) => line.includes(version));
  if (!row) return true;
  // Tablo satırı: Local | Remote | Time — Remote sütununda sürüm görünmeli.
  const cells = row.split("|").map((cell) => cell.trim());
  return !(cells[1] && cells[1].includes(version));
});
if (missing.length > 0) {
  console.error(`Uzakta uygulanmamış görünen migration'lar: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Staging migration geçmişi tam: ${local.length}/${local.length} uygulanmış.`);
