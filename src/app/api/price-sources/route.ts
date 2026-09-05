import { getPriceSourceService, requireUsableUser } from "@/server/auth";
import { ok } from "@/server/http";
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
