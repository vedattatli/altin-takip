import { getAuthService, requireCurrentAdmin } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";

/** Yönetici: kullanıcı listeleme ve arama. */
export async function GET(request: Request) {
  try {
    const actor = await requireCurrentAdmin();
    const search = new URL(request.url).searchParams.get("q") ?? "";
    return ok(await getAuthService().listUsers(actor, search));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Yönetici: yeni kullanıcı oluşturma.
 * Rol gövdeden ALINMAZ; oluşturulan her hesap normal kullanıcıdır.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireCurrentAdmin();
    const body = await readJson<{
      username?: string;
      displayName?: string;
      temporaryPassword?: string;
    }>(request);

    const created = await getAuthService().createUser(actor, {
      username: body.username ?? "",
      displayName: body.displayName ?? "",
      temporaryPassword: body.temporaryPassword ?? "",
    });
    return ok(created, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
