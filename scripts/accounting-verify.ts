/**
 * Muhasebe doğrulaması: defteri yeniden oynatır ve türetilmiş pozisyonlarla karşılaştırır.
 *
 *   npm run accounting:verify            (Supabase: gerçek DB; yoksa yerel depo)
 *   npm run accounting:verify -- --local (yalnızca yerel geliştirme deposu)
 *
 * Üç bağımsız hesap karşılaştırılır:
 *   1. Veritabanındaki türetilmiş projeksiyon (portfolio_positions / positions_list)
 *   2. Postgres içi yeniden oynatma (ledger_verify RPC)
 *   3. TypeScript motoru (src/domain/accounting) ile defterin yeniden oynatılması
 * Herhangi bir tutarsızlıkta çıkış kodu 1'dir. Yapılandırma yoksa 2.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { replayLedger, type ProductPosition } from "../src/domain/accounting";
import type { AuthBackend } from "../src/server/auth/backend";
import { createUserActor, ownScope } from "../src/server/auth/actor";

const args = process.argv.slice(2);

function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

interface Mismatch {
  username: string;
  productId: string;
  field: string;
  stored: string | null;
  recomputed: string | null;
}

function compare(
  username: string,
  stored: ProductPosition[],
  recomputed: Map<string, ProductPosition>,
  mismatches: Mismatch[],
): void {
  const storedById = new Map(stored.map((position) => [position.productId, position]));
  const productIds = new Set([...storedById.keys(), ...recomputed.keys()]);
  for (const productId of productIds) {
    const a = storedById.get(productId);
    const b = recomputed.get(productId);
    if (!a || !b) {
      // Aktif kaydı olmayan ürün için projeksiyon satırı olmaması normaldir.
      if (b && b.activeTransactionCount === 0) continue;
      if (a && a.activeTransactionCount === 0) continue;
      mismatches.push({ username, productId, field: "row", stored: a ? "var" : null, recomputed: b ? "var" : null });
      continue;
    }
    for (const field of ["quantity", "remainingCostBasis", "averageCost", "realizedPnl"] as const) {
      if ((a[field] ?? null) !== (b[field] ?? null)) {
        mismatches.push({ username, productId, field, stored: a[field] ?? null, recomputed: b[field] ?? null });
      }
    }
    for (const field of ["holdingCostOrigins", "realizedPnlOrigins"] as const) {
      const stored = JSON.stringify(a[field]);
      const recomputed = JSON.stringify(b[field]);
      if (stored !== recomputed) mismatches.push({ username, productId, field, stored, recomputed });
    }
    if (a.activeTransactionCount !== b.activeTransactionCount) {
      mismatches.push({
        username,
        productId,
        field: "activeTransactionCount",
        stored: String(a.activeTransactionCount),
        recomputed: String(b.activeTransactionCount),
      });
    }
  }
}

async function main(): Promise<void> {
  const useSupabase = hasSupabaseConfig() && !args.includes("--local");
  if (!useSupabase && !args.includes("--local") && !hasSupabaseConfig()) {
    console.error("Supabase yapılandırması yok; yerel geliştirme deposu doğrulanıyor (--local).");
  }

  const backend: AuthBackend = useSupabase
    ? new (await import("../src/server/auth/supabase-backend")).SupabaseAuthBackend()
    : new (await import("../src/server/auth/local-backend")).LocalAuthBackend({ allowInProduction: true });
  await backend.ensureReady();

  const profiles = await backend.listProfiles({ limit: 10_000 });
  const mismatches: Mismatch[] = [];
  let checkedUsers = 0;
  let checkedProducts = 0;
  let dbVerifyMismatches = 0;

  for (const profile of profiles) {
    const scope = ownScope(createUserActor(profile, "accounting-verify"));
    const [ledger, positions, verify] = await Promise.all([
      backend.listLedger(scope),
      backend.listPositions(scope),
      backend.verifyLedger(scope),
    ]);
    checkedUsers += 1;
    checkedProducts += verify.checked;
    dbVerifyMismatches += verify.mismatches.length;
    for (const mismatch of verify.mismatches) {
      mismatches.push({ username: profile.username, ...mismatch });
    }
    // TypeScript motoru bağımsız olarak oynatır.
    compare(profile.username, positions, replayLedger(ledger), mismatches);
  }

  console.log("");
  console.log(`Arka uç        : ${backend.label}`);
  console.log(`Kullanıcı      : ${checkedUsers}`);
  console.log(`Ürün pozisyonu : ${checkedProducts}`);
  console.log(`DB içi doğrulama tutarsızlığı : ${dbVerifyMismatches}`);
  console.log(`Motor karşılaştırma tutarsızlığı: ${mismatches.length - dbVerifyMismatches}`);

  if (mismatches.length > 0) {
    console.error("");
    console.error("TUTARSIZLIK BULUNDU:");
    for (const mismatch of mismatches) {
      console.error(
        `  ${mismatch.username} / ${mismatch.productId} / ${mismatch.field}: saklanan=${mismatch.stored ?? "null"} yeniden=${mismatch.recomputed ?? "null"}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log("Defter ve türetilmiş pozisyonlar tutarlı.");
}

main().catch((error: unknown) => {
  console.error("Doğrulama çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
