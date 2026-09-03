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
 * Arşiv harici araç kullanılmadan (PowerShell/zip yok) saf Node ile yazılır;
 * böylece giriş adları her platformda "/" ayracı kullanır ve içerik
 * deterministiktir (sabit zaman damgası, sıralı dosyalar).
 *
 * Paket üretildikten sonra YENİDEN AÇILIR: her girişin CRC'si yeniden
 * hesaplanıp başlıkla ve kaynak dosyayla karşılaştırılır, giriş sayısı manifest
 * ile eşleştirilir, secret taraması yapılır. Herhangi biri başarısızsa paket
 * silinir ve komut hata ile biter.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const OUT_DIR = "dist";
const BASENAME = "Altin-Takip-Source";
const ZIP_PATH = join(OUT_DIR, `${BASENAME}.zip`);
const SHA_PATH = `${ZIP_PATH}.sha256`;
const MANIFEST_PATH = join(OUT_DIR, `${BASENAME}.manifest.txt`);

/** Paket dışında bırakılan klasör adları. */
export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".data",
  ".tmp",
  ".staging",
  "dist",
  "test-results",
  "playwright-report",
  "blob-report",
  "coverage",
  ".turbo",
  ".vercel",
  ".vscode",
  ".idea",
  // Yerel Supabase CLI çalışma dosyaları (docker durumu, geçici şema dökümleri).
  ".temp",
  ".branches",
]);

/** Paket dışında bırakılan dosyalar (tam ad veya desen). */
export function isExcludedFile(name) {
  if (name === ".DS_Store" || name === "Thumbs.db") return true;
  if (name.endsWith(".tsbuildinfo")) return true;
  if (name.endsWith(".log")) return true;
  // Gerçek ortam dosyaları (staging dâhil) asla pakete girmez; yalnızca *.example kalır.
  if (name.startsWith(".env") && !name.endsWith(".example")) return true;
  return false;
}

export function collect(dir, root = dir, files = []) {
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
export const REQUIRED = [
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
  "supabase/migrations/0006_database_boundary.sql",
  "supabase/migrations/0013_price_providers.sql",
  "supabase/migrations/0014_price_rpc.sql",
  "supabase/migrations/0015_admin_mfa.sql",
  "supabase/migrations/0016_price_runtime_integrity.sql",
  "supabase/setup/maintenance-cron.sql",
  "supabase/tests/rls.test.sql",
  "src/prices/contract.ts",
  "src/prices/descriptors.ts",
  "src/prices/dev-gate.ts",
  "src/prices/providers/contracts.ts",
  "src/server/security/machine-route.ts",
  "docs/SECURITY.md",
  "docs/ARCHITECTURE.md",
  "docs/PRICE_PROVIDERS.md",
  "docs/PRICE_RUNTIME_INTEGRITY.md",
  "docs/RUNBOOKS.md",
];

/** Pakette bulunmaMASI gereken desenler. */
export const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.data(\/|$)/,
  /(^|\/)test-results(\/|$)/,
  /(^|\/)playwright-report(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env(\.(local|production|development))?$/,
  /(^|\/)\.env\.[^/]*local$/,
  /(^|\/)\.staging(\/|$)/,
];

/** Değeri DOLU olan ortam değişkeni satırı arar. Boş anahtar (KEY=) normaldir. */
function hasFilledEnvVar(content, name) {
  const matcher = new RegExp(`^\\s*(?:${name})\\s*=\\s*\\S`);
  return content.split("\n").some((line) => matcher.test(line.trimEnd()));
}

/** İçerik taramasında aranan secret izleri. */
export const SECRET_PATTERNS = [
  { label: "Supabase service_role JWT", test: (c) => /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(c) },
  { label: "Supabase secret key (sb_secret_...)", test: (c) => /sb_secret_[A-Za-z0-9_-]{16,}/.test(c) },
  { label: "Dolu SUPABASE_SECRET_KEY", test: (c) => hasFilledEnvVar(c, "SUPABASE_SECRET_KEY") },
  { label: "Dolu SUPABASE_SERVICE_ROLE_KEY", test: (c) => hasFilledEnvVar(c, "SUPABASE_SERVICE_ROLE_KEY") },
  { label: "Dolu NEXT_PUBLIC_SUPABASE_ANON_KEY", test: (c) => hasFilledEnvVar(c, "NEXT_PUBLIC_SUPABASE_ANON_KEY") },
  { label: "Dolu RATE_LIMIT_PEPPER", test: (c) => hasFilledEnvVar(c, "RATE_LIMIT_PEPPER") },
  { label: "Dolu AUTH_CSRF_SECRET", test: (c) => hasFilledEnvVar(c, "AUTH_CSRF_SECRET") },
  { label: "Dolu SUPABASE_STAGING_JWT_SECRET", test: (c) => hasFilledEnvVar(c, "SUPABASE_STAGING_JWT_SECRET") },
  // Sprint 3: fiyat sağlayıcı ve yönetici MFA secretları
  { label: "Dolu PRICE_CRON_SECRET", test: (c) => hasFilledEnvVar(c, "PRICE_CRON_SECRET") },
  { label: "Dolu AUTH_MFA_ENCRYPTION_KEY", test: (c) => hasFilledEnvVar(c, "AUTH_MFA_ENCRYPTION_KEY") },
  {
    label: "Dolu sağlayıcı anahtarı (*_API_KEY / *_API_SECRET / *_LICENSE_REFERENCE)",
    test: (c) => hasFilledEnvVar(c, "[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_API_SECRET|[A-Z0-9_]*_LICENSE_REFERENCE"),
  },
  { label: "Özel anahtar bloğu", test: (c) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c) },
];

const TEXT_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|sql|md|css|txt|yml|yaml|toml|example|webmanifest)$/i;

// ------------------------------------------------------------------ ZIP yazımı

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministik paket için sabit DOS zaman damgası: 2026-01-01 00:00:00. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Dosya listesini ZIP arşivi olarak Buffer'a yazar.
 * entries: [{ name: "a/b.txt", data: Buffer }] — name ZORUNLU olarak "/" ayraçlı.
 */
export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.includes("\\") || entry.name.startsWith("/")) {
      throw new Error(`Geçersiz ZIP giriş adı: ${entry.name}`);
    }
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x0314, 4); // version made by: UNIX, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, payload);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * ZIP arşivini yeniden açar; merkezi dizini okur, her girişi açıp CRC'sini
 * yeniden hesaplar. Hata durumunda fırlatır. Dönen: [{ name, data, crc }].
 */
export function readZip(archive) {
  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error("ZIP: merkezi dizin sonu (EOCD) bulunamadı.");
  const total = archive.readUInt16LE(eocdOffset + 10);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < total; i += 1) {
    if (archive.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error("ZIP: merkezi dizin bozuk.");
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP: yerel başlık bozuk: ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === METHOD_DEFLATE ? inflateRawSync(payload) : Buffer.from(payload);

    if (data.length !== uncompressedSize) throw new Error(`ZIP: boyut uyuşmazlığı: ${name}`);
    const actualCrc = crc32(data);
    if (actualCrc !== crc) throw new Error(`ZIP: CRC uyuşmazlığı: ${name}`);
    entries.push({ name, data, crc });
  }
  return entries;
}

// --------------------------------------------------------------------- akış

function fail(message) {
  console.error(`\nPAKETLEME BAŞARISIZ: ${message}`);
  process.exit(1);
}

export function main() {
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

  // Secret taraması arşive yazmadan ÖNCE yapılır; iz varsa paket hiç üretilmez.
  let scanned = 0;
  const findings = [];
  const entries = files.map((file) => {
    const data = readFileSync(file);
    if (TEXT_EXTENSIONS.test(file)) {
      scanned += 1;
      const content = data.toString("utf8");
      for (const { label, test } of SECRET_PATTERNS) {
        if (test(content)) findings.push(`${file} -> ${label}`);
      }
    }
    return { name: `${BASENAME}/${file}`, data };
  });

  if (findings.length > 0) {
    console.error("Secret izi bulundu:");
    for (const finding of findings) console.error(`  ${finding}`);
    fail("Paket üretilmedi. Önce secret sızıntısını giderin.");
  }

  console.log("Arşiv oluşturuluyor (saf Node, '/' ayraçlı girişler)...");
  const archive = buildZip(entries);
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(ZIP_PATH, { force: true });
  writeFileSync(ZIP_PATH, archive);

  // ------------------------------------------------------- yeniden açma doğrulaması
  console.log("Arşiv yeniden açılıp doğrulanıyor...");
  let reopened;
  try {
    reopened = readZip(readFileSync(ZIP_PATH));
  } catch (error) {
    rmSync(ZIP_PATH, { force: true });
    fail(error instanceof Error ? error.message : String(error));
  }

  if (reopened.length !== files.length) {
    rmSync(ZIP_PATH, { force: true });
    fail(`Giriş sayısı uyuşmuyor: arşiv ${reopened.length}, manifest ${files.length}.`);
  }
  const byName = new Map(reopened.map((entry) => [entry.name, entry]));
  for (const entry of entries) {
    const found = byName.get(entry.name);
    if (!found) {
      rmSync(ZIP_PATH, { force: true });
      fail(`Arşivde giriş eksik: ${entry.name}`);
    }
    if (found.name.includes("\\")) {
      rmSync(ZIP_PATH, { force: true });
      fail(`Giriş adı ters bölü içeriyor: ${found.name}`);
    }
    if (found.crc !== crc32(entry.data)) {
      rmSync(ZIP_PATH, { force: true });
      fail(`Kaynak ile arşiv CRC'si uyuşmuyor: ${entry.name}`);
    }
  }

  const sha256 = createHash("sha256").update(archive).digest("hex");
  writeFileSync(SHA_PATH, `${sha256}  ${BASENAME}.zip\n`, "utf8");

  const manifest = [
    `Paket: ${BASENAME}.zip`,
    `Dosya sayısı: ${files.length}`,
    `Arşiv boyutu: ${archive.length} bayt`,
    `SHA-256: ${sha256}`,
    "Giriş ayracı: / (tüm platformlarda)",
    "",
    "Dosyalar:",
    ...files.map((file) => `  ${file}`),
  ].join("\n");
  writeFileSync(MANIFEST_PATH, `${manifest}\n`, "utf8");

  console.log("");
  console.log(`Paket   : ${ZIP_PATH}`);
  console.log(`SHA-256 : ${SHA_PATH}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(
    `Doğrulama: ${scanned} metin dosyası tarandı, ${reopened.length} giriş yeniden açıldı ve CRC'leri eşleşti.`,
  );
  console.log(`Boyut    : ${archive.length} bayt`);
  console.log(`SHA-256  : ${sha256}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join("/").replace(/^.*\//, ""));
if (invokedDirectly) main();
