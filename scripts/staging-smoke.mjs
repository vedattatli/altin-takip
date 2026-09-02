/**
 * Staging duman testi: gerçek JWT'li Data API sondası + muhasebe doğrulaması,
 * staging Supabase projesine karşı.
 *
 *   npm run staging:smoke
 *
 * - service_role'ün doğrudan transaction/snapshot yazamadığı, RPC'lerin çalıştığı,
 *   anon/authenticated sınırları ve hesap silme cascade'i sondada doğrulanır.
 * - accounting:verify sıfır tutarsızlık döndürmelidir.
 * Değerler yazdırılmaz; SUPABASE_STAGING_JWT_SECRET yoksa fail closed.
 */
import { spawnSync } from "node:child_process";

import { requireStagingEnv, stagingProcessEnv } from "./staging/env.mjs";

const shell = process.platform === "win32";
const values = requireStagingEnv();

if (!values.SUPABASE_STAGING_JWT_SECRET) {
  console.error("SUPABASE_STAGING_JWT_SECRET eksik: authenticated JWT üretilemez, sonda ÇALIŞTIRILMADI.");
  console.error("(Supabase Dashboard → Project Settings → API → JWT Secret; .env.staging.local içine yazın.)");
  process.exit(1);
}

const probeEnv = stagingProcessEnv(values, {
  SUPABASE_PROBE_URL: values.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_PROBE_ANON_KEY: values.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_PROBE_SERVICE_KEY: values.SUPABASE_SECRET_KEY,
  SUPABASE_PROBE_JWT_SECRET: values.SUPABASE_STAGING_JWT_SECRET,
});

console.log("== Staging Data API sondası ==");
const probe = spawnSync("node", ["scripts/data-api-probe.mjs"], { stdio: "inherit", shell, env: probeEnv });
if (probe.status !== 0) {
  console.error(`Sonda başarısız (çıkış ${probe.status}).`);
  process.exit(probe.status ?? 1);
}

console.log("");
console.log("== Staging muhasebe doğrulaması (accounting:verify) ==");
const verify = spawnSync(
  "node",
  ["-r", "./scripts/node-server-only-stub.cjs", "--import", "tsx", "scripts/accounting-verify.ts"],
  { stdio: "inherit", shell, env: stagingProcessEnv(values) },
);
if (verify.status !== 0) {
  console.error(`accounting:verify başarısız (çıkış ${verify.status}).`);
  process.exit(verify.status ?? 1);
}
console.log("");
console.log("Staging duman testi geçti.");
