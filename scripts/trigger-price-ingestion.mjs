/**
 * SUNUCU TARAFI FİYAT ALIMINI TETİKLE
 *
 *   node scripts/trigger-price-ingestion.mjs
 *
 * Kapalıçarşı (Anlık Altın) ve Türkiye geneli (Truncgil) kaynakları düz HTTP
 * ile okunur; TARAYICI GEREKTİRMEZ. Bu yüzden toplama işini runner'da değil
 * uygulamanın kendi zamanlanmış ucunda yaptırırız:
 *
 *   runner → POST /api/cron/price-ingestion → sağlayıcılar → kalite kapısı → Supabase
 *
 * Böylece runner'da Supabase service_role BULUNMAZ; yalnız paylaşılan cron
 * secret'ı bilinir.
 *
 * Secret log'a, çıktıya veya artefakta YAZILMAZ. Yanıt yalnız sayıları taşır.
 *
 * Çıkış kodları:
 *   0  en az bir sağlayıcı fiyat yazdı
 *   75 geçici: uç ulaşılabilir ama hiçbir fiyat kabul edilmedi
 *   1  yapılandırma veya beklenmeyen hata
 */

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "").replace(/\/$/u, "");
const SECRET = process.env.PRICE_CRON_SECRET ?? "";
const PATH = "/api/cron/price-ingestion";

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

async function main() {
  if (APP_BASE_URL === "") {
    log("config_error", { variable: "APP_BASE_URL" });
    process.exit(1);
  }
  if (SECRET === "") {
    log("config_error", { variable: "PRICE_CRON_SECRET" });
    process.exit(1);
  }

  log("ingestion_start", { target: new URL(PATH, APP_BASE_URL).host });

  let response;
  try {
    response = await fetch(`${APP_BASE_URL}${PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    log("network_error", { code: error instanceof Error ? error.name : "UNKNOWN" });
    process.exit(75);
  }

  if (!response.ok) {
    // Gövde secret içermez ama yine de yazılmaz; yalnız durum kodu raporlanır.
    log("ingestion_rejected", { status: response.status });
    process.exit(response.status >= 500 ? 75 : 1);
  }

  const body = await response.json().catch(() => ({}));
  const providers = body?.data?.providers ?? [];
  let accepted = 0;
  for (const provider of providers) {
    log("provider_result", {
      provider: provider.providerCode ?? "unknown",
      attempted: provider.attempted ?? false,
      status: provider.status ?? "unknown",
      accepted: provider.accepted ?? 0,
      quarantined: provider.quarantined ?? 0,
      error: provider.safeErrorCode ?? null,
    });
    accepted += provider.accepted ?? 0;
  }

  log("ingestion_done", { totalAccepted: accepted });
  process.exit(accepted > 0 ? 0 : 75);
}

void main();
