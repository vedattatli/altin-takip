import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

type Context = { params: Promise<{ id: string }> };

/**
 * "Düzenle": mevcut kayıt REPLACED olur, yerine yeni kayıt eklenir (tek işlem).
 * Başka kullanıcının kaydı kimlik tahminiyle değiştirilemez: kapsam oturumdan gelir.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const actor = await requireUsableUser();
  const { id } = await context.params;
  const body = await readJson<unknown>(request);
  return ok(await getUserPortfolioService().replaceTransaction(actor, id, body));
});

/** "Sil": kayıt VOID olur; sebep ve tarih kaydedilir. Hard delete YOKTUR. */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const actor = await requireUsableUser();
  const { id } = await context.params;
  const body = await request
    .json()
    .then((value) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}))
    .catch(() => ({}) as Record<string, unknown>);
  return ok(await getUserPortfolioService().voidTransaction(actor, id, body.reason));
});
