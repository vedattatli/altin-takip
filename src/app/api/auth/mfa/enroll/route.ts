import { getMfaService, requireAdminForMfaSetup } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * İkinci faktör kurulumunu başlatır.
 * Secret ve kurtarma kodları YALNIZCA bu yanıtta döner; tekrar gösterilmez ve loglanmaz.
 */
export const POST = apiRoute(async () => {
  const actor = await requireAdminForMfaSetup();
  const result = await getMfaService().startEnrollment(actor, actor.profile.username);
  return ok(result, { status: 201 });
});
