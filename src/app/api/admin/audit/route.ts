import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Denetim kayıtları — SALT OKUNUR.
 * Kayıt düzenleme veya silme ucu bilinçli olarak YOKTUR; veritabanı da
 * tetikleyici ile UPDATE/DELETE işlemlerini engeller.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  return ok(await getAdminService().listAudit(actor, Math.min(Math.max(limit, 1), 200)));
});
