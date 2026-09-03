import { getMfaService, requireAdminForMfaSetup } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Kurulumu ilk doğru kodla tamamlar ve bu oturumu doğrulanmış işaretler. */
export const POST = apiRoute(async (request) => {
  const actor = await requireAdminForMfaSetup();
  const body = await readJson<{ code?: unknown }>(request);
  await getMfaService().confirmEnrollment(actor, body.code);
  return ok({ confirmed: true });
});
