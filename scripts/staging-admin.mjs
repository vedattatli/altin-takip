/**
 * Staging yönetici hesabı: mevcut güvenli `admin:create` akışını staging ortamıyla çalıştırır.
 *
 *   npm run staging:admin -- --username <ad> --display-name "<görünen ad>"
 *
 * Parola terminalde gizli girilir; hiçbir yere yazdırılmaz. Kullanıcı adı,
 * .staging/accounts.local.json dosyasına (yalnızca ad) kaydedilir ki temizlik
 * aracı yöneticiyi onay olmadan silmesin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ACCOUNTS_FILE, requireStagingEnv, stagingProcessEnv } from "./staging/env.mjs";

const values = requireStagingEnv();
const args = process.argv.slice(2);
const usernameIndex = args.indexOf("--username");
const username = usernameIndex >= 0 ? args[usernameIndex + 1] : null;

const result = spawnSync(
  "node",
  ["-r", "./scripts/node-server-only-stub.cjs", "--import", "tsx", "scripts/admin-create.ts", ...args],
  { stdio: "inherit", shell: process.platform === "win32", env: stagingProcessEnv(values) },
);
if (result.status !== 0) process.exit(result.status ?? 1);

if (username) {
  const file = existsSync(ACCOUNTS_FILE)
    ? JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"))
    : { projectRef: values.SUPABASE_STAGING_PROJECT_REF, baseUrl: values.STAGING_BASE_URL, createdAt: new Date().toISOString(), users: [] };
  file.admin = { username };
  mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`Yönetici adı ${ACCOUNTS_FILE} dosyasına kaydedildi (parola kaydedilmez).`);
}
