import { getAuthService, requireCurrentAdmin } from "@/server/auth";
import { badRequest } from "@/server/auth/errors";
import { failure, ok, readJson } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireCurrentAdmin();
    const { id } = await context.params;
    return ok(await getAuthService().getUserDetail(actor, id));
  } catch (error) {
    return failure(error);
  }
}

/** Pasifleştirme / yeniden aktifleştirme. Varsayılan yönetim işlemi budur. */
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireCurrentAdmin();
    const { id } = await context.params;
    const body = await readJson<{ status?: string }>(request);
    if (body.status !== "active" && body.status !== "inactive") {
      throw badRequest("Durum yalnızca active veya inactive olabilir.");
    }
    return ok(await getAuthService().setUserStatus(actor, id, body.status));
  } catch (error) {
    return failure(error);
  }
}

/**
 * KALICI SİLME. Açık onay olmadan çalışmaz:
 * gövdede confirmUsername alanı hedefin kullanıcı adıyla birebir eşleşmelidir.
 */
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = await requireCurrentAdmin();
    const { id } = await context.params;
    const body = await readJson<{ confirmUsername?: string }>(request);
    await getAuthService().deleteUser(actor, id, body.confirmUsername ?? "");
    return ok({ deleted: true });
  } catch (error) {
    return failure(error);
  }
}
