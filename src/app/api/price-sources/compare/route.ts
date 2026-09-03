import { getPriceSourceService, requireUsableUser } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kaynak karşılaştırma verisi.
 * Bu ekrandaki fiyatlar DEĞERLEMEYE karışmaz; yalnızca gösterim içindir.
 */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  return ok(await getPriceSourceService().compareSources(actor));
});
