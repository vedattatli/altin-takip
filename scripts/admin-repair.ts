/**
 * Yönetici onarımı: profili olup varsayılan portföyü / tercih kaydı olmayan
 * kullanıcıları tamamlar.
 *
 *   npm run admin:repair            (Supabase: provision_missing_defaults() RPC)
 *   npm run admin:repair -- --local (yerel geliştirme deposu)
 *
 * - İdempotenttir: eksik kayıt yoksa hiçbir şey yapmaz ve 0 döner.
 * - GET /api/portfolio ASLA veri oluşturmaz; eksik kayıt yalnızca bu komutla
 *   (veya profil oluşturma tetikleyicisiyle) tamamlanır.
 * - Yalnızca sunucu anahtarıyla çalışır; tarayıcıdan çağrılamaz.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const args = process.argv.slice(2);

function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

async function main(): Promise<void> {
  const useSupabase = hasSupabaseConfig();
  const allowLocal = args.includes("--local");

  if (!useSupabase && !allowLocal) {
    console.error("Supabase yapılandırması eksik. Onarım ÇALIŞTIRILMADI.");
    console.error("Yerel geliştirme deposu için: npm run admin:repair -- --local");
    process.exitCode = 1;
    return;
  }

  const backend = useSupabase
    ? new (await import("../src/server/auth/supabase-backend")).SupabaseAuthBackend()
    : new (await import("../src/server/auth/local-backend")).LocalAuthBackend();

  await backend.ensureReady();
  const repaired = await backend.provisionMissingDefaults();

  console.log("");
  console.log(`Arka uç : ${backend.label}`);
  console.log(`Onarılan: ${repaired} kullanıcı`);
  console.log(repaired === 0 ? "Eksik kayıt yoktu; hiçbir şey değişmedi." : "Eksik portföy/tercih kayıtları tamamlandı.");
  console.log("");
}

main().catch((error: unknown) => {
  console.error("Onarım çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
