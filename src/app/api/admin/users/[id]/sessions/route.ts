import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

/**
 * Yönetici: kullanıcının aktif oturumları (güvenli metadata: cihaz etiketi,
 * oluşturulma ve son görülme zamanı). Ham IP veya User-Agent DÖNMEZ.
 */
export const GET = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  return ok(await getAdminService().listUserSessions(actor, id));
});

/** Yönetici: kullanıcının TÜM oturumlarını kapatır. */
export const DELETE = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  return ok(await getAdminService().revokeUserSessions(actor, id));
});
