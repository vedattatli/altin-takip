import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Kullanıcının KENDİ işlemleri. Kimlik yalnızca oturumdan türetilir. */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  return ok(await getUserPortfolioService().listTransactions(actor));
});

export const POST = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const body = await readJson<unknown>(request);
  return ok(await getUserPortfolioService().createTransaction(actor, body), { status: 201 });
});

export const DELETE = apiRoute(async () => {
  const actor = await requireUsableUser();
  await getUserPortfolioService().clearTransactions(actor);
  return ok(null);
});
