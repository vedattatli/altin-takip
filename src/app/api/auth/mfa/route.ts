import { getMfaService, getSessionContext, requireAuthenticatedUser } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** İkinci faktör durumu. Secret veya kurtarma kodu DÖNMEZ. */
export const GET = apiRoute(async () => {
  const actor = await requireAuthenticatedUser();
  const session = await getSessionContext();
  return ok(await getMfaService().status(actor.profile, session?.mfaVerifiedAt ?? null));
});
