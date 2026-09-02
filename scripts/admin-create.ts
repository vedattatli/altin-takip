/**
 * İlk yönetici hesabını güvenli biçimde oluşturur.
 *
 *   npm run admin:create
 *
 * KURALLAR
 * - Kullanıcı adı ve parola kaynak kodda YOKTUR; her ikisi de çalışma anında sorulur.
 * - Parola terminale yazdırılmaz, kabuk geçmişine düşmez, log'lanmaz.
 * - "admin" rolü yalnızca bu komutla verilir; uygulama arayüzünden verilemez.
 * - Supabase yapılandırması yoksa komut GERÇEK kullanıcı oluşturmuş gibi davranmaz;
 *   eksik ayarları raporlar. Yerel geliştirme hesabı için --local bayrağı gerekir.
 */
import { config as loadEnv } from "dotenv";
import { createInterface } from "node:readline/promises";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { validatePassword } from "../src/auth/password";
import { isReservedUsername, validateUsername } from "../src/auth/username";

const args = process.argv.slice(2);

const KEY_LF = 10;
const KEY_CR = 13;
const KEY_EOT = 4;
const KEY_ETX = 3;
const KEY_BACKSPACE = 8;
const KEY_DELETE = 127;

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function option(name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1] ?? null;
}

function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/** Terminalde yankısız (gizli) parola okuma. Girilen karakterler ekrana basılmaz. */
async function readHiddenLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const input = process.stdin;

  if (!input.isTTY) {
    // TTY yoksa (CI, script) parola stdin'den satır olarak okunur; yine yazdırılmaz.
    const rl = createInterface({ input, terminal: false });
    const iterator = rl[Symbol.asyncIterator]();
    const next = await iterator.next();
    rl.close();
    process.stdout.write("\n");
    return typeof next.value === "string" ? next.value : "";
  }

  return new Promise((resolve) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const onData = (chunk: string) => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);

        if (code === KEY_LF || code === KEY_CR || code === KEY_EOT) {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (code === KEY_ETX) {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (code === KEY_DELETE || code === KEY_BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    input.on("data", onData);
  });
}

async function ask(prompt: string, preset: string | null): Promise<string> {
  if (preset) return preset;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

function reportMissingSupabase(): void {
  console.error("");
  console.error("Supabase yapılandırması eksik. GERÇEK yönetici hesabı OLUŞTURULMADI.");
  console.error("");
  console.error("Gerekli ortam değişkenleri (.env.local):");
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    const present = Boolean(process.env[name]);
    console.error(`  ${present ? "[var]" : "[EKSİK]"} ${name}`);
  }
  console.error("");
  console.error("Kurulum adımları:");
  console.error("  1. .env.example dosyasını .env.local olarak kopyalayın.");
  console.error("  2. Supabase proje URL'si ve anahtarlarını doldurun.");
  console.error("  3. supabase/migrations altındaki SQL dosyalarını sırayla uygulayın.");
  console.error("  4. Bu komutu tekrar çalıştırın.");
  console.error("");
  console.error("Yalnızca yerel geliştirme hesabı için: npm run admin:create -- --local");
  console.error("(Bu hesap Supabase'de DEĞİL, .data/auth-local.json dosyasında tutulur.)");
}

async function main(): Promise<void> {
  const useSupabase = hasSupabaseConfig();
  const allowLocal = flag("local");

  if (!useSupabase && !allowLocal) {
    reportMissingSupabase();
    process.exitCode = 1;
    return;
  }

  if (useSupabase) {
    console.log("");
    console.log("== SUPABASE YÖNETİCİ HESABI ==");
    console.log("");
  } else {
    console.log("");
    console.log("== YEREL GELİŞTİRME HESABI ==");
    console.log("Bu hesap Supabase'de OLUŞTURULMAZ. Yalnızca bu makinedeki");
    console.log(".data/auth-local.json dosyasında saklanır ve üretimde çalışmaz.");
    console.log("");
  }

  const rawUsername = await ask("Kullanıcı adı: ", option("username"));
  const username = validateUsername(rawUsername);
  if (!username.ok) {
    console.error(`Hata: ${username.error}`);
    process.exitCode = 1;
    return;
  }
  if (isReservedUsername(username.value)) {
    console.error("Hata: Bu kullanıcı adı sistem tarafından ayrılmıştır.");
    process.exitCode = 1;
    return;
  }

  const displayName = (await ask("Görünen ad: ", option("display-name"))).trim();
  if (displayName.length < 2 || displayName.length > 80) {
    console.error("Hata: Görünen ad 2-80 karakter olmalıdır.");
    process.exitCode = 1;
    return;
  }

  // Parola: önce ortam değişkeni (otomasyon), yoksa gizli terminal girişi.
  const envPassword = process.env.ADMIN_PASSWORD ?? "";
  const password = envPassword || (await readHiddenLine("Parola (görünmez): "));
  const confirmation = envPassword || (await readHiddenLine("Parola (tekrar): "));

  if (password !== confirmation) {
    console.error("Hata: Parolalar eşleşmiyor.");
    process.exitCode = 1;
    return;
  }

  const policy = validatePassword(password, username.value);
  if (!policy.ok) {
    console.error(`Hata: ${policy.error}`);
    process.exitCode = 1;
    return;
  }

  const backend = useSupabase
    ? new (await import("../src/server/auth/supabase-backend")).SupabaseAuthBackend()
    : new (await import("../src/server/auth/local-backend")).LocalAuthBackend();

  await backend.ensureReady();

  const existing = await backend.findProfileByUsername(username.value);
  if (existing) {
    console.error("Hata: Bu kullanıcı adı zaten kullanılıyor.");
    process.exitCode = 1;
    return;
  }

  const created = await backend.createUser({
    username: username.value,
    displayName,
    temporaryPassword: password,
    role: "admin",
  });

  // Yönetici parolayı kendisi belirlediği için ilk girişte değiştirme zorunlu değildir.
  await backend.setMustChangePassword(created.id, false);

  await backend.appendAudit({
    adminUserId: created.id,
    adminUsername: created.username,
    targetUserId: created.id,
    targetUsername: created.username,
    action: "user.create",
    success: true,
    metadata: { bootstrap: true, backend: backend.id },
  });

  console.log("");
  console.log("Yönetici hesabı oluşturuldu.");
  console.log(`  Kullanıcı adı : ${created.username}`);
  console.log(`  Görünen ad    : ${created.displayName}`);
  console.log("  Rol           : admin");
  console.log(`  Arka uç       : ${backend.label}`);
  console.log("");
  console.log("Parola kasıtlı olarak ekrana yazdırılmadı ve hiçbir yere kaydedilmedi.");
  console.log("");
}

main().catch((error: unknown) => {
  console.error("Yönetici hesabı oluşturulamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
