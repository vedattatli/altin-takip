import { cookies } from "next/headers";

import { getAuthService, requireAuthenticatedUser, SESSION_COOKIE } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcının kendi parolasını değiştirmesi.
 *
 * Geçici parolalı kullanıcının kullanabildiği ÜÇ uçtan biridir; bu yüzden
 * requireUsableUser değil requireAuthenticatedUser kullanılır.
 * Mevcut parola doğrulanmadan yeni parola kabul edilmez ve başarılı
 * değişiklikten sonra TÜM oturumlar düşer.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
  const actor = await requireAuthenticatedUser();

  await getAuthService().changeOwnPassword(
    actor,
    body.currentPassword ?? "",
    body.newPassword ?? "",
  );

  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return ok({ changed: true });
});
