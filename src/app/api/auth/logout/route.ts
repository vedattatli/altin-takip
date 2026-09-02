import { cookies } from "next/headers";

import { getAuthService, markSessionEnded, readSessionToken, SESSION_COOKIE } from "@/server/auth";
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
  store.delete(SESSION_COOKIE);
  return ok({ signedOut: true });
});
