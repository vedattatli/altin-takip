/**
 * Staging test verisini güvenle temizler.
 *
 *   npm run staging:cleanup
 *   npm run staging:cleanup -- --include-admin   (+ STAGING_CLEANUP_ADMIN_CONFIRM=<admin kullanıcı adı>)
 *
 * - Yalnızca hesap dosyasındaki ve "staging" önekli test kullanıcılarını siler
 *   (profil/portföy/işlem/anlık görüntü/pozisyon/oturum cascade ile).
 * - Yönetici bootstrap hesabı kullanıcı onayı olmadan SİLİNMEZ.
 * - Silme sonucu doğrulanır; sessizce yok sayılmaz.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { ACCOUNTS_FILE, requireStagingEnv, stagingProcessEnv } from "./staging/env.mjs";

const values = requireStagingEnv()!;
Object.assign(process.env, stagingProcessEnv(values));
const includeAdmin = process.argv.includes("--include-admin");

interface AccountsFile {
  projectRef: string;
  admin?: { username: string };
  users: { username: string; role: string }[];
}

async function main(): Promise<void> {
  if (!existsSync(ACCOUNTS_FILE)) {
    console.log(`${ACCOUNTS_FILE} yok; temizlenecek staging hesabı kaydı bulunmuyor.`);
    return;
  }
  const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as AccountsFile;
  if (accounts.projectRef !== values.SUPABASE_STAGING_PROJECT_REF) {
    console.error("Hesap dosyası başka bir proje ref'ine ait; temizlik yapılmadı.");
    process.exit(1);
  }

  const { SupabaseAuthBackend } = await import("../src/server/auth/supabase-backend");
  const backend = new SupabaseAuthBackend();
  await backend.ensureReady();

  let failures = 0;
  const remaining: AccountsFile["users"] = [];
  for (const user of accounts.users) {
    if (!user.username.startsWith("staging") || user.role !== "user") {
      remaining.push(user);
      continue;
    }
    const profile = await backend.findProfileByUsername(user.username);
    if (!profile) {
      console.log(`  [yok]     ${user.username}`);
      continue;
    }
    await backend.deleteUser(profile.id);
    const stillThere = await backend.getProfile(profile.id);
    if (stillThere) {
      failures += 1;
      console.error(`  [HATA]    ${user.username} silinemedi`);
      remaining.push(user);
    } else {
      console.log(`  [silindi] ${user.username}`);
    }
  }

  if (accounts.admin) {
    const confirm = process.env.STAGING_CLEANUP_ADMIN_CONFIRM ?? "";
    if (includeAdmin && confirm === accounts.admin.username) {
      const profile = await backend.findProfileByUsername(accounts.admin.username);
      if (profile) {
        await backend.deleteUser(profile.id);
        console.log(`  [silindi] ${accounts.admin.username} (yönetici, açık onayla)`);
        delete accounts.admin;
      }
    } else {
      console.log(`  [korundu] ${accounts.admin.username} (yönetici; silmek için --include-admin ve STAGING_CLEANUP_ADMIN_CONFIRM)`);
    }
  }

  if (remaining.length === 0 && !accounts.admin) {
    unlinkSync(ACCOUNTS_FILE);
    console.log(`${ACCOUNTS_FILE} kaldırıldı.`);
  } else {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify({ ...accounts, users: remaining }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  if (failures > 0) {
    console.error(`${failures} hesap silinemedi.`);
    process.exit(1);
  }
  console.log("Staging temizliği tamamlandı.");
}

main().catch((error: unknown) => {
  console.error("Temizlik çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
