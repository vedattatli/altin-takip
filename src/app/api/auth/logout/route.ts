import { cookies } from "next/headers";

import {
  getAuthService,
  isSecureRequest,
  markSessionEnded,
  readSessionToken,
  SESSION_COOKIE,
} from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Normal çıkış: YALNIZCA bu cihazdaki oturum kaydı ve çerez silinir.
 * Diğer cihazlardaki oturumlar açık kalır. Geçici parolalı kullanıcı da
 * bu ucu kullanabilir.
 */
export const POST = apiRoute(async () => {
  const token = await readSessionToken();
  await getAuthService().logout(token);
  markSessionEnded();
  const store = await cookies();
  // `store.delete()` KULLANMA: Next silme çerezini `Secure` bayrağı olmadan
  // yazar, tarayıcı ise `__Host-` önekli bir çerezi `Secure` olmadan kabul
  // etmez; silme talimatı tümüyle reddedilir ve ölü jeton tarayıcıda kalır.
  // Bu yüzden çerez, giriş yolundaki modelin aynısıyla (HttpOnly + Secure +
  // SameSite=Lax + Path=/) boş değer ve Max-Age=0 ile geçersiz kılınır.
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return ok({ signedOut: true });
});
