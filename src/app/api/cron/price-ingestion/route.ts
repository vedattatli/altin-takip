import { getPriceIngestionService } from "@/server/auth";
import { ok } from "@/server/http";
import { machineRoute } from "@/server/security/machine-route";

/**
 * Zamanlanmış fiyat alımı.
 *
 * - MAKİNE ucudur: `machineRoute` kullanır, tarayıcı CSRF çerezi veya oturum
 *   BEKLEMEZ. `apiRoute` ile sarılsaydı zamanlayıcının elinde çerez olmadığı
 *   için istek doğru secret'la bile CSRF aşamasında reddedilirdi.
 * - Secret ile korunur (`PRICE_CRON_SECRET`); yoksa uç KAPALIDIR (fail closed).
 * - Idempotenttir: koşum anahtarı sunucuda dakikaya yuvarlanarak üretilir, aynı
 *   dakikada tekrarlanan çağrı ikinci fiyat geçmişi satırı oluşturmaz.
 * - Yalnızca etkin ve lisanslı sağlayıcılar çekilir; test sağlayıcısı üretimde çalışmaz.
 * - Yanıt secret, upstream adres veya ham payload İÇERMEZ.
 */
export const dynamic = "force-dynamic";

export const POST = machineRoute(
  { secretEnv: "PRICE_CRON_SECRET", runKeyPrefix: "price-ingestion" },
  async (_request, _context, machine) => {
    const service = getPriceIngestionService();
    await service.syncCatalog();
    const outcomes = await service.ingestEnabled({ runKey: machine.runKey });
    return ok({
      runKey: machine.runKey,
      minute: machine.minuteIso,
      providers: outcomes.map((outcome) => ({
        providerCode: outcome.providerCode,
        attempted: outcome.attempted,
        status: outcome.result?.status ?? "SKIPPED",
        accepted: outcome.accepted,
        quarantined: outcome.quarantined.length,
        replayed: outcome.result?.replayed ?? false,
        safeErrorCode: outcome.safeErrorCode,
      })),
    });
  },
);
