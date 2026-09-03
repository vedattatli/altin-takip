import { getMfaService, requireAdminForMfaSetup } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Oturum için ikinci faktörü doğrular (TOTP veya kurtarma kodu). */
export const POST = apiRoute(async (request) => {
  const actor = await requireAdminForMfaSetup();
  const body = await readJson<{ code?: unknown }>(request);
  const result = await getMfaService().verify(actor, body.code);
  return ok({ verified: true, usedRecoveryCode: result.usedRecoveryCode });
});
