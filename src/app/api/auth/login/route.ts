import { cookies } from "next/headers";

import {
  clientKey,
  getAuthService,
  isSecureRequest,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcı adı + parola ile giriş.
 *
 * Herkese açık KAYIT ucu YOKTUR. Kullanıcılar yalnızca yönetici tarafından
 * oluşturulur. Bu uç da apiRoute sarmalayıcısı sayesinde origin ve CSRF
 * kontrolünden geçer; ayrıca paylaşımlı hız sınırlayıcıya tabidir.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{
    username?: string;
    password?: string;
    deviceMode?: string;
  }>(request);

  // Yalnızca "personal" açıkça seçilirse kalıcı oturum verilir; aksi hâlde
  // en kısıtlayıcı mod (ortak cihaz) uygulanır.
  const deviceMode = body.deviceMode === "personal" ? "personal" : "shared";

  const result = await getAuthService().login(
    body.username ?? "",
    body.password ?? "",
    await clientKey(),
    deviceMode,
  );

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(result.expiresAt, result.policy, await isSecureRequest()),
  );

  return ok({ user: result.user, deviceMode: result.deviceMode });
});
