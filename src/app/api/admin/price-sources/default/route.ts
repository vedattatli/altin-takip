import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Yönetici: AÇIK global varsayılan fiyat kaynağı.
 *
 * Tercihini kendisi yapmamış kullanıcılar bu kaynağı kullanır. "Listedeki ilk
 * açık kaynak" gibi örtük bir davranış YOKTUR. Kendi tercihini yapmış
 * kullanıcıların seçimi bu değişiklikten ETKİLENMEZ.
 */
export const PUT = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const body = await readJson<{ providerCode?: unknown }>(request);
  const code = typeof body.providerCode === "string" && body.providerCode.trim() !== "" ? body.providerCode.trim() : null;
  return ok({ providerCode: await getAdminService().setDefaultPriceProvider(actor, code) });
});
