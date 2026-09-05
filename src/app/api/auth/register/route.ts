import { cookies, headers } from "next/headers";

import { AppError } from "@/server/auth/errors";
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
 * istenmez. Oturum kuralları giriş ucuyla birebir aynıdır. Otomatik giriş
 * başarısız olursa hesap yine de açılmış olur; bu durum 409 +
 * `registered_not_signed_in` ile bildirilir (aşağıdaki nota bakın).
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

  // Buraya gelindiyse hesap ARTIK VAR. Otomatik giriş ayrı bir adımdır ve kendi
  // GİRİŞ hız sınırı kovalarını kullanır; kullanıcı daha önce yanlış parolayla
  // deneyip o kovayı kilitlediyse burası 429 fırlatır. Ham hatayı yukarı
  // bırakmak kayıt formuna "Çok fazla başarısız giriş denemesi" yazdırır ve
  // kullanıcı hesabın açılmadığını sanır (sonra aynı adı denediğinde "bu ad
  // kullanılıyor" alır). Bu yüzden giriş adımının HER hatası, hesabın
  // açıldığını söyleyen tek bir mesaja çevrilir.
  let result;
  try {
    result = await service.login(
      body.username ?? "",
      body.password ?? "",
      key,
      deviceLabel,
      body.keepSignedIn === true,
    );
  } catch {
    throw new AppError(
      409,
      "Hesabınız oluşturuldu ancak otomatik giriş yapılamadı. Giriş sayfasından giriş yapın.",
      "registered_not_signed_in",
    );
  }

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    result.token,
    sessionCookieOptions(result.expiresAt, await isSecureRequest(), result.persistent),
  );

  return ok({ user: result.user, persistent: result.persistent }, { status: 201 });
});
