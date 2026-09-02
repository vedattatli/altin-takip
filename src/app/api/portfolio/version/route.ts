import { NextResponse } from "next/server";

import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/**
 * Defter sürümü — cihazlar arası senkronizasyon için hafif, salt okunur uç.
 *
 * - Yalnızca doğrulanmış kullanıcının KENDİ sürümünü döner; hedef userId alınmaz.
 * - ETag / If-None-Match: sürüm değişmediyse gövdesiz 304.
 * - Hiçbir şey yazmaz; CSRF gerektirmeyen GET; yanıt önbelleğe alınmaz.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const version = await getUserPortfolioService().getLedgerRevision(actor);
  const etag = `W/"rev-${version.revision}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return ok(version, { headers });
});
