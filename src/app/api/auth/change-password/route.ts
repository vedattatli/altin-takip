import { getAuthService, requireAuthenticatedUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcının kendi parolasını değiştirmesi.
 *
 * Geçici parolalı kullanıcının kullanabildiği uçlardan biridir; bu yüzden
 * requireUsableUser değil requireAuthenticatedUser kullanılır.
 * Mevcut parola doğrulanmadan yeni parola kabul edilmez. Başarılı
 * değişiklikten sonra BU cihazdaki oturum korunur; diğer bütün cihazlar
 * güvenlik için kapatılır.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
  const actor = await requireAuthenticatedUser();

  await getAuthService().changeOwnPassword(
    actor,
    body.currentPassword ?? "",
    body.newPassword ?? "",
  );

  return ok({ changed: true });
});
