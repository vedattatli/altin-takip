import { cookies, headers } from "next/headers";

import {
  clientKey,
  getAuthService,
  isSecureRequest,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { describeDevice } from "@/server/security/device-label";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcı adı + parola ile giriş.
 *
 * Herkese açık KAYIT ucu YOKTUR. Kullanıcılar yalnızca yönetici tarafından
 * oluşturulur. Bu uç da apiRoute sarmalayıcısı sayesinde origin ve CSRF
 * kontrolünden geçer; ayrıca paylaşımlı hız sınırlayıcıya tabidir.
 *
 * Cihaz türü SORULMAZ: her cihazda aynı kalıcı oturum verilir. Yalnızca kaba
 * bir cihaz etiketi (tarayıcı · sistem) oturum kaydına yazılır; ham User-Agent
 * veya IP saklanmaz.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{ username?: string; password?: string }>(request);
  const deviceLabel = describeDevice((await headers()).get("user-agent"));

  const result = await getAuthService().login(
    body.username ?? "",
    body.password ?? "",
    await clientKey(),
    deviceLabel,
  );

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(result.expiresAt, await isSecureRequest()),
  );

  return ok({ user: result.user });
});
