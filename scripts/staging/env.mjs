/**
 * Staging ortam yardımcıları (Sprint 2).
 *
 * KURALLAR
 * - Gerçek değerler `.env.staging.local` dosyasındadır: gitignore'dadır, kaynak ZIP'e girmez,
 *   bu betikler HİÇBİR değeri konsola yazmaz (yalnızca "var / EKSİK").
 * - Eksik veya tutarsız yapılandırmada başarılı olmuş gibi davranılmaz: fail closed.
 * - Production hedefi asla staging aracıyla değiştirilmez (proje ref karşılaştırılır).
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

export const STAGING_ENV_FILE = ".env.staging.local";
export const ACCOUNTS_FILE = ".staging/accounts.local.json";

export const REQUIRED_VARS = [
  "STAGING_ENVIRONMENT",
  "STAGING_BASE_URL",
  "APP_ORIGIN",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_STAGING_PROJECT_REF",
  "AUTH_CSRF_SECRET",
  "RATE_LIMIT_PEPPER",
  "TRUSTED_PROXY_PROVIDER",
];

export const OPTIONAL_VARS = [
  "SUPABASE_STAGING_JWT_SECRET",
  "SUPABASE_PRODUCTION_PROJECT_REF",
  "AUTH_INTERNAL_EMAIL_DOMAIN",
  "VERCEL_STAGING_PROJECT",
];

/** Client'a gidebilecek (NEXT_PUBLIC_) değişkenlerde bulunmaması gereken secret izleri. */
const SECRET_VALUE_PATTERNS = [/^sb_secret_/i, /^-----BEGIN/];

function looksLikeServiceRoleJwt(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && payload.role === "service_role";
  } catch {
    return false;
  }
}

export function readStagingEnv(file = STAGING_ENV_FILE) {
  if (!existsSync(file)) return { values: null, problems: [`${file} bulunamadı. Örnek: .env.staging.example`] };
  try {
    return { values: parse(readFileSync(file, "utf8")), problems: [] };
  } catch (error) {
    return { values: null, problems: [`${file} okunamadı: ${error.message}`] };
  }
}

/** Değerleri yazmadan doğrular; her sorun için açıklayıcı Türkçe metin döner. */
export function validateStagingEnv(values) {
  const problems = [];
  if (!values) return ["Yapılandırma yok."];
  for (const name of REQUIRED_VARS) {
    if (!values[name] || String(values[name]).trim() === "") problems.push(`${name} eksik.`);
  }
  if (values.STAGING_ENVIRONMENT !== "staging") {
    problems.push('STAGING_ENVIRONMENT tam olarak "staging" olmalıdır (production hedefi reddedilir).');
  }
  const origin = (values.APP_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1/.test(origin)) {
    problems.push("APP_ORIGIN https:// ile başlayan sabit bir staging adresi olmalıdır (localhost olamaz).");
  }
  if ((values.STAGING_BASE_URL ?? "").trim().replace(/\/+$/, "") !== origin) {
    problems.push("STAGING_BASE_URL ile APP_ORIGIN birebir aynı olmalıdır (CSRF/origin sınırı gevşetilmez).");
  }
  const ref = (values.SUPABASE_STAGING_PROJECT_REF ?? "").trim();
  const supabaseUrl = (values.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (ref && supabaseUrl && !supabaseUrl.includes(ref)) {
    problems.push("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_STAGING_PROJECT_REF ile uyuşmuyor.");
  }
  if (supabaseUrl && /localhost|127\.0\.0\.1/.test(supabaseUrl)) {
    problems.push("NEXT_PUBLIC_SUPABASE_URL yerel yığını gösteriyor; staging uzak bir proje olmalıdır.");
  }
  const productionRef = (values.SUPABASE_PRODUCTION_PROJECT_REF ?? "").trim();
  if (productionRef && productionRef === ref) {
    problems.push("Staging proje ref'i production ref'i ile aynı; staging araçları production'a dokunamaz.");
  }
  if ((values.NEXT_PUBLIC_ENABLE_DEMO_MODE ?? "").trim() === "true") {
    problems.push("NEXT_PUBLIC_ENABLE_DEMO_MODE staging'de true olamaz (demo modu kapalı).");
  }
  if (values.AUTH_ALLOW_LOCAL_BACKEND) {
    problems.push("AUTH_ALLOW_LOCAL_BACKEND staging'de tanımlanamaz (yalnızca otomatik test kaçış kapısı).");
  }
  if ((values.TRUSTED_PROXY_PROVIDER ?? "") !== "vercel") {
    problems.push('TRUSTED_PROXY_PROVIDER staging (Vercel) için "vercel" olmalıdır.');
  }
  for (const [name, value] of Object.entries(values)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    const text = String(value ?? "");
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text)) || looksLikeServiceRoleJwt(text)) {
      problems.push(`${name} bir SECRET içeriyor; NEXT_PUBLIC_ değişkenleri istemciye gider.`);
    }
    if (/SECRET|SERVICE_ROLE|PEPPER|CSRF/i.test(name)) {
      problems.push(`${name}: secret adı NEXT_PUBLIC_ önekiyle kullanılamaz.`);
    }
  }
  const secret = String(values.SUPABASE_SECRET_KEY ?? "");
  if (secret && !(secret.startsWith("sb_secret_") || looksLikeServiceRoleJwt(secret))) {
    problems.push("SUPABASE_SECRET_KEY biçimi tanınmadı (sb_secret_... veya service_role JWT bekleniyor).");
  }
  for (const name of ["AUTH_CSRF_SECRET", "RATE_LIMIT_PEPPER"]) {
    if (values[name] && String(values[name]).length < 32) problems.push(`${name} en az 32 karakter olmalıdır.`);
  }
  return problems;
}

/** Alt süreçler için ortam: staging değerleri + mevcut PATH vb. Değerler yazdırılmaz. */
export function stagingProcessEnv(values, extra = {}) {
  return {
    ...process.env,
    ...values,
    NEXT_PUBLIC_ENABLE_DEMO_MODE: "false",
    AUTH_ALLOW_LOCAL_BACKEND: "",
    ...extra,
  };
}

/** Yapılandırmayı yükler ve doğrular; sorun varsa yazdırıp süreci 1 ile bitirir (fail closed). */
export function requireStagingEnv() {
  const { values, problems } = readStagingEnv();
  const allProblems = [...problems, ...(values ? validateStagingEnv(values) : [])];
  if (allProblems.length > 0) {
    console.error("STAGING YAPILANDIRMASI GEÇERSİZ — işlem yapılmadı (fail closed):");
    for (const problem of allProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  return values;
}

/** Değer yazmadan durum satırı. */
export function presence(values, name) {
  return values && values[name] && String(values[name]).trim() !== "" ? "[var]   " : "[EKSİK] ";
}
