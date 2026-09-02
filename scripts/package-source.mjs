/**
 * Temiz kaynak paketi üretir.
 *
 *   npm run package:source
 *
 * Çıktı:
 *   dist/Altin-Takip-Source.zip
 *   dist/Altin-Takip-Source.zip.sha256
 *   dist/Altin-Takip-Source.manifest.txt
 *
 * PAKETE GİRMEYENLER: .git, node_modules, .next, .data, gerçek .env dosyaları,
 * Playwright çıktıları, test-results, coverage, tsbuildinfo, geçici loglar.
 * PAKETE GİRENLER: kaynak kod, migration'lar, testler, dokümanlar, .env.example.
 *
 * Paket üretildikten sonra yeniden açılır; secret taraması ve temel dosya
 * kontrolü yapılır. Kontrol başarısız olursa komut hata ile biter.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const OUT_DIR = "dist";
const BASENAME = "Altin-Takip-Source";
const ZIP_PATH = join(OUT_DIR, `${BASENAME}.zip`);
const SHA_PATH = `${ZIP_PATH}.sha256`;
const MANIFEST_PATH = join(OUT_DIR, `${BASENAME}.manifest.txt`);

/** Paket dışında bırakılan klasör adları. */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".data",
  ".tmp",
  "dist",
  "test-results",
  "playwright-report",
  "blob-report",
  "coverage",
  ".turbo",
  ".vercel",
  ".vscode",
  ".idea",
]);

/** Paket dışında bırakılan dosyalar (tam ad veya desen). */
function isExcludedFile(name) {
  if (name === ".DS_Store" || name === "Thumbs.db") return true;
  if (name.endsWith(".tsbuildinfo")) return true;
  if (name.endsWith(".log")) return true;
  // .env.example DIŞINDAKİ tüm .env dosyaları dışlanır.
  if (name.startsWith(".env") && name !== ".env.example") return true;
  return false;
}

function collect(dir, root = dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      collect(full, root, files);
    } else {
      if (isExcludedFile(entry)) continue;
      files.push(relative(root, full).split(sep).join("/"));
    }
  }
  return files;
}

/** Pakette bulunması ZORUNLU dosyalar. */
const REQUIRED = [
  "package.json",
  "README.md",
  "CLAUDE.md",
  ".env.example",
  "next.config.ts",
  "tsconfig.json",
  "src/config/app.config.ts",
  "src/domain/catalog.ts",
  "src/server/auth/actor.ts",
  "supabase/migrations/0001_init.sql",
  "supabase/migrations/0005_security_hardening.sql",
  "supabase/tests/rls.test.sql",
  "docs/SECURITY.md",
  "docs/ARCHITECTURE.md",
];

/** Pakette bulunmaMASI gereken desenler. */
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.data(\/|$)/,
  /(^|\/)test-results(\/|$)/,
  /(^|\/)playwright-report(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env(\.(local|production|development))?$/,
];

/** Değeri DOLU olan ortam değişkeni satırı arar. Boş anahtar (KEY=) normaldir. */
function hasFilledEnvVar(content, name) {
  const matcher = new RegExp(`^\\s*${name}\\s*=\\s*\\S`);
  return content.split("\n").some((line) => matcher.test(line.trimEnd()));
}

/** İçerik taramasında aranan secret izleri. */
const SECRET_PATTERNS = [
  { label: "Supabase service_role JWT", test: (c) => /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(c) },
  { label: "Dolu SUPABASE_SERVICE_ROLE_KEY", test: (c) => hasFilledEnvVar(c, "SUPABASE_SERVICE_ROLE_KEY") },
  { label: "Dolu NEXT_PUBLIC_SUPABASE_ANON_KEY", test: (c) => hasFilledEnvVar(c, "NEXT_PUBLIC_SUPABASE_ANON_KEY") },
  { label: "Dolu RATE_LIMIT_PEPPER", test: (c) => hasFilledEnvVar(c, "RATE_LIMIT_PEPPER") },
  { label: "Dolu AUTH_CSRF_SECRET", test: (c) => hasFilledEnvVar(c, "AUTH_CSRF_SECRET") },
  { label: "Özel anahtar bloğu", test: (c) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c) },
];

const TEXT_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|sql|md|css|txt|yml|yaml|example|webmanifest)$/i;

function fail(message) {
  console.error(`\nPAKETLEME BAŞARISIZ: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- paketleme

console.log("Kaynak dosyaları toplanıyor...");
const files = collect(process.cwd()).sort();
console.log(`  ${files.length} dosya`);

for (const file of files) {
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(file)) fail(`Yasaklı dosya listeye girdi: ${file}`);
  }
}

for (const required of REQUIRED) {
  if (!files.includes(required)) fail(`Zorunlu dosya eksik: ${required}`);
}

// Geçici klasöre kopyala (zip aracı klasör üzerinden çalışır).
const staging = mkdtempSync(join(tmpdir(), "altin-takip-src-"));
const stagingRoot = join(staging, BASENAME);
for (const file of files) {
  const target = join(stagingRoot, file);
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(file, target);
}

mkdirSync(OUT_DIR, { recursive: true });
rmSync(ZIP_PATH, { force: true });

console.log("Arşiv oluşturuluyor...");
const isWindows = process.platform === "win32";
const zipResult = isWindows
  ? spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${stagingRoot}' -DestinationPath '${join(process.cwd(), ZIP_PATH)}' -Force`,
      ],
      { stdio: "inherit" },
    )
  : spawnSync("zip", ["-r", "-q", join(process.cwd(), ZIP_PATH), BASENAME], {
      cwd: staging,
      stdio: "inherit",
    });

if (zipResult.status !== 0 || !existsSync(ZIP_PATH)) {
  rmSync(staging, { recursive: true, force: true });
  fail("Arşiv oluşturulamadı (zip aracı bulunamadı veya hata verdi).");
}

// ------------------------------------------------------- doğrulama ve özet

console.log("Paket içeriği doğrulanıyor...");

let scanned = 0;
const findings = [];
for (const file of files) {
  if (!TEXT_EXTENSIONS.test(file)) continue;
  scanned += 1;
  const content = readFileSync(join(stagingRoot, file), "utf8");
  for (const { label, test } of SECRET_PATTERNS) {
    if (test(content)) findings.push(`${file} -> ${label}`);
  }
}

rmSync(staging, { recursive: true, force: true });

if (findings.length > 0) {
  rmSync(ZIP_PATH, { force: true });
  console.error("Secret izi bulundu:");
  for (const finding of findings) console.error(`  ${finding}`);
  fail("Paket silindi. Önce secret sızıntısını giderin.");
}

const archive = readFileSync(ZIP_PATH);
const sha256 = createHash("sha256").update(archive).digest("hex");
writeFileSync(SHA_PATH, `${sha256}  ${BASENAME}.zip\n`, "utf8");

const manifest = [
  `Paket: ${BASENAME}.zip`,
  `Dosya sayısı: ${files.length}`,
  `Arşiv boyutu: ${archive.length} bayt`,
  `SHA-256: ${sha256}`,
  "",
  "Dosyalar:",
  ...files.map((file) => `  ${file}`),
].join("\n");
writeFileSync(MANIFEST_PATH, `${manifest}\n`, "utf8");

console.log("");
console.log(`Paket   : ${ZIP_PATH}`);
console.log(`SHA-256 : ${SHA_PATH}`);
console.log(`Manifest: ${MANIFEST_PATH}`);
console.log(`Doğrulama: ${scanned} metin dosyası tarandı, secret izi bulunamadı.`);
console.log(`SHA-256  : ${sha256}`);
