import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string; sessionId: string }> };

/** Yönetici: kullanıcının belirli bir oturumunu kapatır. */
export const DELETE = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { id, sessionId } = await context.params;
  return ok(await getAdminService().revokeUserSession(actor, id, sessionId));
});
