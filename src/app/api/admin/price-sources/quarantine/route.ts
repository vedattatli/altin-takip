import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Yönetici: karantinaya alınmış fiyat kayıtları.
 *
 * Salt okunurdur. Ham sağlayıcı yanıtı, adres veya anahtar DÖNMEZ; yalnızca
 * hangi ürünün hangi sebeple reddedildiği ve reddedilen değerler görünür.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const url = new URL(request.url);
  const code = url.searchParams.get("kaynak");
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;
  return ok(
    await getAdminService().listPriceQuarantine(actor, code && code.trim() !== "" ? code : null, limit),
  );
});
