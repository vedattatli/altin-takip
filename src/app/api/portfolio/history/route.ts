import { getPortfolioHistoryService, requireUsableUser } from "@/server/auth";
import { badRequest } from "@/server/auth/errors";
import { ok } from "@/server/http";
import { isHistoryRange } from "@/server/portfolio/portfolio-history-service";
import { apiRoute } from "@/server/security/route";

/**
 * Portföy değeri zaman serisi (grafik).
 *
 * - Kapsam yalnızca `ownScope(actor)` ile kurulur; gövdeden/sorgudan hedef
 *   kullanıcı kimliği ALINMAZ.
 * - Salt okunur GET; hiçbir şey yazmaz, yanıt önbelleğe alınmaz.
 * - Aralık kapalı bir listeden gelir; serbest metin kabul edilmez.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const range = new URL(request.url).searchParams.get("range") ?? "24h";
  if (!isHistoryRange(range)) {
    throw badRequest("Geçersiz aralık.");
  }
  const series = await getPortfolioHistoryService().series(actor, range);
  return ok(series, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
});
