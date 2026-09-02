/**
 * Staging test hesapları (User A / User B) — gerçek kullanıcı verisi DEĞİLDİR.
 *
 *   npm run staging:seed
 *
 * - Parolalar rastgele üretilir; kaynak koda yazılmaz, terminale yazdırılmaz.
 * - Hesap bilgileri yalnızca `.staging/accounts.local.json` (gitignore) dosyasına yazılır;
 *   staging E2E bu dosyayı okur.
 * - Yönetici hesabı bu betikle OLUŞTURULMAZ: `npm run staging:admin` (güvenli admin:create akışı).
 * - Kullanıcılar geçici parolayla, ilk girişte parola değiştirme zorunluluğuyla oluşturulur.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ACCOUNTS_FILE, requireStagingEnv, stagingProcessEnv } from "./staging/env.mjs";

const values = requireStagingEnv()!;
Object.assign(process.env, stagingProcessEnv(values));

const USERS = [
  { username: "stagingusera", displayName: "Staging Kullanıcı A" },
  { username: "staginguserb", displayName: "Staging Kullanıcı B" },
] as const;

interface AccountRecord {
  username: string;
  displayName: string;
  role: "user" | "admin";
  temporaryPassword?: string;
  currentPassword?: string;
  mustChangePassword: boolean;
}

interface AccountsFile {
  projectRef: string;
  baseUrl: string;
  createdAt: string;
  admin?: { username: string };
  users: AccountRecord[];
}

function strongPassword(): string {
  // 20 karakter: büyük/küçük harf, rakam ve işaret; kelime listesine dayanmaz.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!$%*+-=?@";
  const bytes = randomBytes(20);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 6)}Kz${out.slice(6, 14)}7${out.slice(14)}`;
}

function readAccounts(): AccountsFile {
  if (existsSync(ACCOUNTS_FILE)) {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as AccountsFile;
  }
  return {
    projectRef: values.SUPABASE_STAGING_PROJECT_REF,
    baseUrl: values.STAGING_BASE_URL,
    createdAt: new Date().toISOString(),
    users: [],
  };
}

function writeAccounts(file: AccountsFile): void {
  mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function main(): Promise<void> {
  const { SupabaseAuthBackend } = await import("../src/server/auth/supabase-backend");
  const backend = new SupabaseAuthBackend();
  await backend.ensureReady();

  const accounts = readAccounts();
  if (accounts.projectRef !== values.SUPABASE_STAGING_PROJECT_REF) {
    console.error("Hesap dosyası başka bir proje ref'ine ait; staging:cleanup ile temizleyip yeniden deneyin.");
    process.exit(1);
  }

  let created = 0;
  for (const spec of USERS) {
    const existing = await backend.findProfileByUsername(spec.username);
    if (existing) {
      if (!accounts.users.some((user) => user.username === spec.username)) {
        console.error(`${spec.username} staging'de var ama hesap dosyasında yok; parola bilinmiyor. staging:cleanup sonrası yeniden seed edin.`);
        process.exit(1);
      }
      console.log(`  [var]   ${spec.username}`);
      continue;
    }
    const temporaryPassword = strongPassword();
    await backend.createUser({
      username: spec.username,
      displayName: spec.displayName,
      temporaryPassword,
      role: "user",
    });
    accounts.users = accounts.users.filter((user) => user.username !== spec.username);
    accounts.users.push({
      username: spec.username,
      displayName: spec.displayName,
      role: "user",
      temporaryPassword,
      mustChangePassword: true,
    });
    created += 1;
    console.log(`  [yeni]  ${spec.username}`);
  }
  writeAccounts(accounts);
  console.log("");
  console.log(`Staging test kullanıcıları hazır (${created} yeni). Kimlik bilgileri: ${ACCOUNTS_FILE} (gitignore).`);
  console.log("Yönetici hesabı için: npm run staging:admin");
}

main().catch((error: unknown) => {
  console.error("Seed çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
