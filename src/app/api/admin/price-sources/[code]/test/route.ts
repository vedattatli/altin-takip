import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ code: string }> };

/** Yönetici: bağlantı testi. Secret DÖNMEZ; yalnızca durum ve güvenli hata kodu. */
export const POST = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { code } = await context.params;
  return ok(await getAdminService().testPriceProvider(actor, code));
});
