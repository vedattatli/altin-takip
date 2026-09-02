import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

export const PUT = apiRoute<Context>(async (request, context) => {
  const actor = await requireUsableUser();
  const { id } = await context.params;
  const body = await readJson<unknown>(request);
  return ok(await getUserPortfolioService().updateTransaction(actor, id, body));
});

export const DELETE = apiRoute<Context>(async (_request, context) => {
  const actor = await requireUsableUser();
  const { id } = await context.params;
  await getUserPortfolioService().deleteTransaction(actor, id);
  return ok(null);
});
