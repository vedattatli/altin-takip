import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ code: string }> };

/**
 * Yönetici: kaynağı etkinleştirir / kullanıcı seçimine açar.
 * Lisans veya yeniden gösterim izni yoksa etkinleştirme REDDEDİLİR (fail closed).
 */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const actor = await requireCurrentAdmin();
  const { code } = await context.params;
  const body = await readJson<{ enabled?: unknown; userSelectable?: unknown }>(request);
  return ok(
    await getAdminService().setPriceProviderFlags(
      actor,
      code,
      body.enabled === true,
      body.userSelectable === true,
    ),
  );
});
