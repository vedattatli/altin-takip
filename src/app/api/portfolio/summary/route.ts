import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Sunucu tarafı değerleme: türetilmiş pozisyonlar + güncel (test) fiyat.
 * Salt okuma; hiçbir şey yazmaz. Fiyat yoksa/bayatsa değerleme alanları null'dır.
 */
export const GET = apiRoute(async () => {
  const actor = await requireUsableUser();
  return ok(await getUserPortfolioService().getSummary(actor));
});
