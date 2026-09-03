import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Hesap/veri silme talebi.
 * Silme işlemini yönetici yapar; bu uç talebi kaydeder ve kullanıcıya ne olacağını bildirir.
 */
export const POST = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const body = await readJson<{ reason?: unknown }>(request);
  return ok(await getUserPortfolioService().requestAccountDeletion(actor, body.reason), { status: 201 });
});
