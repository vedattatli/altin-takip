import { cookies } from "next/headers";

import { getAuthService, readSessionToken, SESSION_COOKIE } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Çıkış. Geçici parolalı kullanıcı da bu ucu kullanabilir. */
export const POST = apiRoute(async () => {
  const token = await readSessionToken();
  await getAuthService().logout(token);
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return ok({ signedOut: true });
});
