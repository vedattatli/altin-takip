import { cookies } from "next/headers";

import {
  getAuthService,
  markSessionEnded,
  requireAuthenticatedUser,
  SESSION_COOKIE,
} from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * "Tüm cihazlardan çıkış yap": kullanıcının BÜTÜN oturum kayıtları iptal
 * edilir (bu cihaz dâhil). Kimlik doğrulanmış oturumdan türetilir; gövdeden
 * kullanıcı kimliği alınmaz. Geçici parolalı kullanıcı da kullanabilir.
 */
export const POST = apiRoute(async () => {
  const actor = await requireAuthenticatedUser();
  const closed = await getAuthService().logoutEverywhere(actor);
  markSessionEnded();
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return ok({ signedOut: true, closedSessions: closed });
});
