import { cookies } from "next/headers";

import { getAuthService, requireCurrentUser, SESSION_COOKIE } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";

/**
 * Kullanıcının kendi parolasını değiştirmesi.
 * Mevcut parola doğrulanmadan yeni parola kabul edilmez.
 * Başarılı değişiklikten sonra TÜM oturumlar düşürülür; kullanıcı yeniden giriş yapar.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
    const actor = await requireCurrentUser();

    await getAuthService().changeOwnPassword(
      actor,
      body.currentPassword ?? "",
      body.newPassword ?? "",
    );

    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return ok({ changed: true });
  } catch (error) {
    return failure(error);
  }
}
