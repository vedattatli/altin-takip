import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok, readJson } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Kullanıcının KENDİ işlem defteri. Kimlik yalnızca oturumdan türetilir.
 * Miktar ve tutarlar ondalık DİZE olarak taşınır.
 */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  return ok(await getUserPortfolioService().listLedger(actor));
});

/**
 * OPENING_BALANCE / BUY / SELL ekler.
 * Gövde `clientRequestId` taşırsa aynı istek iki kez işlenmez (idempotent);
 * aynı anahtar farklı içerikle gelirse 409 döner.
 */
export const POST = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const body = await readJson<unknown>(request);
  const result = await getUserPortfolioService().appendTransaction(actor, body);
  return ok(result, { status: result.replayed ? 200 : 201 });
});
