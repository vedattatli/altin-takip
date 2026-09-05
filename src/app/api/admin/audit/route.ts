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
  // `??` yalnızca null için devreye girer: `?limit=` boş dize olarak gelir ve
  // Number("") = 0, Number("abc") = NaN olur. Böylece eksik liste tam liste gibi
  // görünürdü. Yalnızca pozitif tam sayıyı kabul et, aksi halde varsayılan 50.
  const rawLimit = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  return ok(await getAdminService().listAudit(actor, limit));
});
