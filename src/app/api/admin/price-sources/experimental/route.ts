import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

const SCREEN_CODE = "sarraf-tv-kayseri-screen";

/**
 * Yönetici: deneysel ekran kaynağının portföy izin listesi.
 *
 * Kullanıcı kendi kendine erişim AÇAMAZ; bu uç yalnızca yöneticiye açıktır ve
 * her değişiklik denetim kaydı üretir.
 */
export const GET = apiRoute(async () => {
  const actor = await requireCurrentAdmin();
  const [access, worker] = await Promise.all([
    getAdminService().listExperimentalAccess(actor, SCREEN_CODE),
    getAdminService().screenWorkerState(actor, SCREEN_CODE),
  ]);
  return ok({ access, worker });
});

export const PUT = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const body = await readJson<{
    userId?: unknown;
    enabled?: unknown;
    reason?: unknown;
    expiresAt?: unknown;
  }>(request);
  const userId = typeof body.userId === "string" ? body.userId : "";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "";
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt.trim() !== "" ? body.expiresAt : null;
  await getAdminService().setExperimentalAccess(actor, userId, SCREEN_CODE, body.enabled === true, reason, expiresAt);
  return ok({ userId, enabled: body.enabled === true });
});
