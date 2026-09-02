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
 * "Bu cihazda oturumumu açık tut" işaretliyse kalıcı çerez + 180 gün kaydırmalı
 * oturum; değilse tarayıcı oturumu çerezi + 8 saat / 30 dk sunucu sınırı.
 * Yalnızca kaba bir cihaz etiketi (tarayıcı · sistem) oturum kaydına yazılır;
 * ham User-Agent veya IP saklanmaz.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{ username?: string; password?: string; keepSignedIn?: unknown }>(
    request,
  );
  const deviceLabel = describeDevice((await headers()).get("user-agent"));
  // Yalnızca açık `true` kalıcı oturum ister; başka her değer tarayıcı oturumudur.
  // Admin hesapları için sunucu bu tercihi yok sayar (asla kalıcı değil).
  const keepSignedIn = body.keepSignedIn === true;

  const result = await getAuthService().login(
    body.username ?? "",
    body.password ?? "",
    await clientKey(),
    deviceLabel,
    keepSignedIn,
  );

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(result.expiresAt, await isSecureRequest(), result.persistent),
  );

  return ok({ user: result.user, persistent: result.persistent });
});
