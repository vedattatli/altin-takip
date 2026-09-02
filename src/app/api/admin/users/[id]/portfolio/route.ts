import { getAuthService, requireCurrentAdmin } from "@/server/auth";
import { failure, ok } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

/** Yönetici: kullanıcının uygulamaya kaydettiği portföyü görüntüleme (salt okunur). */
export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireCurrentAdmin();
    const { id } = await context.params;
    return ok(await getAuthService().getUserPortfolio(actor, id));
  } catch (error) {
    return failure(error);
  }
}
