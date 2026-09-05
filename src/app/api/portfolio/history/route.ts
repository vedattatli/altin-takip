import { getPortfolioHistoryService, requireUsableUser } from "@/server/auth";
import { badRequest } from "@/server/auth/errors";
import { ok } from "@/server/http";
import { isHistoryInterval } from "@/server/portfolio/portfolio-history-service";
import { apiRoute } from "@/server/security/route";

/**
 * Portföy değeri zaman serisi (grafik).
 *
 * - Kapsam yalnızca `ownScope(actor)` ile kurulur; gövdeden/sorgudan hedef
 *   kullanıcı kimliği ALINMAZ.
 * - Salt okunur GET; hiçbir şey yazmaz, yanıt önbelleğe alınmaz.
 * - Aralık (mum adımı) kapalı bir listeden gelir; serbest metin kabul edilmez.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const interval = new URL(request.url).searchParams.get("interval") ?? "1h";
  if (!isHistoryInterval(interval)) {
    throw badRequest("Geçersiz aralık.");
  }
  const series = await getPortfolioHistoryService().series(actor, interval);
  return ok(series, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
});
