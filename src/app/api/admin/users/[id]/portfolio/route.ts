import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

/** Yönetici: kullanıcının portföyünü görüntüleme (salt okunur, denetim kaydı üretir). */
export const GET = apiRoute<Context>(async (_request, context) => {
  const actor = await requireCurrentAdmin();
  const { id } = await context.params;
  return ok(await getAdminService().getUserPortfolio(actor, id));
});
