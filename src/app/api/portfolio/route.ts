import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcının KENDİ portföyü.
 * Hedef kullanıcı kimliği gövdeden/parametreden ALINMAZ; her zaman oturumdan gelir.
 */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  return ok(await getUserPortfolioService().getPortfolio(actor));
});

export const PATCH = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const body = await readJson<{ name?: string; displayName?: string }>(request);
  return ok(await getUserPortfolioService().renamePortfolio(actor, body));
});
