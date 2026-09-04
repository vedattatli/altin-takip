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
 * HERKESE AÇIK KAYIT — kullanıcı adı + parola + parola tekrarı.
 *
 * Ürün kararı (sahibi verdi): siteye giren herkes kendi hesabını açabilir.
 * Uç internete açıktır; korumalar servis katmanında uygulanır: giriş ucuyla
 * aynı hız sınırlayıcı, kullanıcı adı doğrulama, ayrılmış ad reddi, parola
 * politikası ve sunucu tarafı parola tekrarı kontrolü.
 *
 * ROL İSTEMCİDEN ALINMAZ. Gövdede `role` gönderilse bile okunmaz; her kayıt
 * `user` rolüyle açılır. `admin` yalnızca `npm run admin:create` ile verilir.
 *
 * Kayıt başarılıysa kullanıcı DOĞRUDAN oturum açar; ayrıca giriş yapması
 * istenmez. Oturum kuralları giriş ucuyla birebir aynıdır.
 */
export const POST = apiRoute(async (request) => {
  const body = await readJson<{
    username?: string;
    displayName?: string;
    password?: string;
    passwordConfirm?: string;
    keepSignedIn?: unknown;
  }>(request);

  const service = getAuthService();
  const key = await clientKey();

  await service.register(
    {
      username: body.username ?? "",
      displayName: body.displayName ?? "",
      password: body.password ?? "",
      passwordConfirm: body.passwordConfirm ?? "",
    },
    key,
  );

  const deviceLabel = describeDevice((await headers()).get("user-agent"));
  const result = await service.login(
    body.username ?? "",
    body.password ?? "",
    key,
    deviceLabel,
    body.keepSignedIn === true,
  );

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(result.expiresAt, await isSecureRequest(), result.persistent),
  );

  return ok({ user: result.user, persistent: result.persistent }, { status: 201 });
});
