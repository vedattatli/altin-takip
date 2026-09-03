import { getAdminService, getMfaService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

/**
 * Yönetici başka bir yöneticinin ikinci faktörünü sıfırlar.
 * Açık onay (kullanıcı adı) ve denetim kaydı zorunludur; hedefin oturumları kapanır.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  const body = await readJson<{ confirmation?: unknown }>(request);
  await getMfaService().resetForUser(actor, id, body.confirmation);
  await getAdminService().recordMfaReset(actor, id);
  return ok({ reset: true });
});
