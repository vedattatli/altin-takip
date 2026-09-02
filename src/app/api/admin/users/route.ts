import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Yönetici: kullanıcı listeleme ve arama. */
export const GET = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const search = new URL(request.url).searchParams.get("q") ?? "";
  return ok(await getAdminService().listUsers(actor, search));
});

/**
 * Yönetici: yeni kullanıcı oluşturma.
 * Rol gövdeden ALINMAZ; oluşturulan her hesap normal kullanıcıdır.
 */
export const POST = apiRoute(async (request) => {
  const actor = await requireCurrentAdmin();
  const body = await readJson<{
    username?: string;
    displayName?: string;
    temporaryPassword?: string;
  }>(request);

  const created = await getAdminService().createUser(actor, {
    username: body.username ?? "",
    displayName: body.displayName ?? "",
    temporaryPassword: body.temporaryPassword ?? "",
  });
  return ok(created, { status: 201 });
});
