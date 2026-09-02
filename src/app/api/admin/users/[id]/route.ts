import { badRequest } from "@/server/auth/errors";
import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  return ok(await getAdminService().getUserDetail(actor, id));
});

/** Pasifleştirme / yeniden aktifleştirme. Varsayılan yönetim işlemi budur. */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  const body = await readJson<{ status?: string }>(request);
  if (body.status !== "active" && body.status !== "inactive") {
    throw badRequest("Durum yalnızca active veya inactive olabilir.");
  }
  return ok(await getAdminService().setUserStatus(actor, id, body.status));
});

/**
 * KALICI SİLME. Açık onay olmadan çalışmaz:
 * gövdedeki confirmUsername hedefin kullanıcı adıyla birebir eşleşmelidir.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  const body = await readJson<{ confirmUsername?: string }>(request);
  const result = await getAdminService().deleteUser(actor, id, body.confirmUsername ?? "");
  return ok(result);
});
