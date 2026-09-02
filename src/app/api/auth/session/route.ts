import { toSessionUser } from "@/auth/types";
import { getSessionContext } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Mevcut oturum bilgisi.
 * Geçici parolalı kullanıcı da erişebilir; istemci mustChangePassword
 * alanına bakarak parola değiştirme ekranına yönlenir.
 */
export const GET = apiRoute(async () => {
  const session = await getSessionContext();
  return ok({
    user: session ? toSessionUser(session.profile) : null,
    // Kalıcı oturumda kaydırmalı bitiş; tarayıcı oturumunda mutlak bitiş.
    expiresAt: session?.expiresAt ?? null,
    persistent: session?.persistent ?? null,
  });
});
