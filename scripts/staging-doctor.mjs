/**
 * Staging hazırlık denetimi.
 *
 *   npm run staging:doctor
 *
 * Kontroller: Node/npm sürümü, git çalışma ağacı, Supabase CLI ve oturumu, Vercel CLI
 * ve oturumu, gerekli ortam değişkeni ADLARI (değerler yazılmaz), APP_ORIGIN, demo modu,
 * production dışı hedef, secretların NEXT_PUBLIC_ değişkenlerde bulunmaması.
 * Herhangi bir zorunlu kontrol başarısızsa çıkış kodu 1 (fail closed).
 */
import { spawnSync } from "node:child_process";

import {
  OPTIONAL_VARS,
  presence,
  readStagingEnv,
  REQUIRED_VARS,
  STAGING_ENV_FILE,
  validateStagingEnv,
} from "./staging/env.mjs";

const shell = process.platform === "win32";
let failed = false;

function line(ok, label, detail = "", required = true) {
  const mark = ok ? "[ok]    " : required ? "[HATA]  " : "[uyarı] ";
  console.log(`${mark}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok && required) failed = true;
}

function run(command, args, timeoutMs = 45_000) {
  const result = spawnSync(command, args, { encoding: "utf8", shell, timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

console.log("== Staging doktoru ==");
console.log("");

// Node / npm
const nodeMajor = Number(process.versions.node.split(".")[0]);
line(nodeMajor >= 20, `Node ${process.versions.node}`, nodeMajor >= 20 ? "" : "Node 20+ gerekir");
const npm = run("npm", ["--version"], 20_000);
line(npm.status === 0, `npm ${npm.stdout.trim() || "?"}`);

// Git çalışma ağacı
const git = run("git", ["status", "--porcelain"], 20_000);
if (git.status !== 0) line(false, "git deposu", "git status çalışmadı", false);
else line(git.stdout.trim() === "", "git çalışma ağacı temiz", git.stdout.trim() === "" ? "" : "commit edilmemiş değişiklik var", false);
const branch = run("git", ["branch", "--show-current"], 20_000);
line(branch.status === 0, `git dalı: ${branch.stdout.trim() || "?"}`, "", false);

// Supabase CLI ve oturum
const supabaseVersion = run("npx", ["--no-install", "supabase", "--version"], 60_000);
line(supabaseVersion.status === 0, `Supabase CLI ${supabaseVersion.stdout.trim() || ""}`, supabaseVersion.status === 0 ? "" : "npx supabase bulunamadı");
if (supabaseVersion.status === 0) {
  const projects = run("npx", ["--no-install", "supabase", "projects", "list"], 60_000);
  const authed = projects.status === 0;
  line(authed, "Supabase CLI oturumu", authed ? "projects list çalıştı" : "giriş gerekli: npx supabase login", false);
}

// Vercel CLI ve oturum
const vercel = run("npx", ["--no-install", "vercel", "--version"], 60_000);
if (vercel.status === 0) {
  const who = run("npx", ["--no-install", "vercel", "whoami"], 60_000);
  line(who.status === 0, "Vercel CLI oturumu", who.status === 0 ? "whoami çalıştı" : "giriş gerekli: npx vercel login", false);
} else {
  line(false, "Vercel CLI", "npx vercel bulunamadı (npm i -D vercel ya da npx vercel login)", false);
}

// Ortam değişkenleri (değerler YAZILMAZ)
console.log("");
console.log(`Ortam dosyası: ${STAGING_ENV_FILE}`);
const { values, problems } = readStagingEnv();
line(values !== null, `${STAGING_ENV_FILE} okundu`, problems[0] ?? "");
if (values) {
  for (const name of REQUIRED_VARS) console.log(`  ${presence(values, name)}${name}`);
  for (const name of OPTIONAL_VARS) console.log(`  ${presence(values, name)}${name} (isteğe bağlı)`);
  const envProblems = validateStagingEnv(values);
  for (const problem of envProblems) line(false, problem);
  if (envProblems.length === 0) {
    line(true, "APP_ORIGIN sabit https staging adresi; STAGING_BASE_URL ile aynı");
    line(true, "Demo modu kapalı; yerel arka uç kaçış kapısı yok");
    line(true, "Hedef production değil (proje ref karşılaştırıldı)");
    line(true, "NEXT_PUBLIC_ değişkenlerinde secret izi yok");
  }
}

// Kaynak paketi / gitignore güvenliği
const ignoreCheck = run("git", ["check-ignore", "-q", STAGING_ENV_FILE], 20_000);
line(ignoreCheck.status === 0, `${STAGING_ENV_FILE} gitignore kapsamında`);
const accountsIgnore = run("git", ["check-ignore", "-q", ".staging/accounts.local.json"], 20_000);
line(accountsIgnore.status === 0, ".staging/ gitignore kapsamında");

console.log("");
if (failed) {
  console.error("SONUÇ: staging hazır DEĞİL. Yukarıdaki [HATA] satırlarını giderin.");
  process.exit(1);
}
console.log("SONUÇ: zorunlu kontroller geçti. Uyarılar varsa gözden geçirin.");
