import { getPriceSourceService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Kullanıcının seçebileceği kaynaklar + aktif kaynak + değişim geçmişi. */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  const service = getPriceSourceService();
  const [options, active, events] = await Promise.all([
    service.listSelectableSources(actor),
    service.activeSnapshot(actor),
    service.listSourceEvents(actor, 10),
  ]);
  return ok({ options, active: active.source, events });
});

/**
 * Kaynak değiştirme. Yalnızca yöneticinin açtığı kaynaklar seçilebilir.
 * Geçmiş işlem maliyetleri ve başlangıç snapshot'ları DEĞİŞMEZ; yalnızca güncel
 * değerleme etkilenir. Her değişiklik denetim olayı üretir.
 */
export const POST = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const body = await readJson<{ providerCode?: unknown; reason?: unknown }>(request);
  const result = await getPriceSourceService().selectSource(actor, body.providerCode, body.reason);
  return ok(result);
});
