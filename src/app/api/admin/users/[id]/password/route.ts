import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

/**
 * Yönetici: geçici parola atama.
 * Yönetici mevcut parolayı GÖREMEZ; yalnızca yeni geçici parola belirleyebilir.
 * Sıfırlama sonrası kullanıcının tüm oturumları düşer.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  const body = await readJson<{ temporaryPassword?: string }>(request);
  return ok(await getAdminService().resetUserPassword(actor, id, body.temporaryPassword ?? ""));
});
