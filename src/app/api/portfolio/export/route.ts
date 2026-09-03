import { NextResponse } from "next/server";

import { getUserPortfolioService, requireUsableUser } from "@/server/auth";
import { apiRoute } from "@/server/security/route";
import { ledgerCsv, positionsCsv } from "@/server/portfolio/csv";

/**
 * Kullanıcının KENDİ verisini CSV olarak dışa aktarması.
 * Yalnızca oturumdaki kullanıcının verisi; hedef kimlik alınmaz.
 */
export const GET = apiRoute(async (request) => {
  const actor = await requireUsableUser();
  const kind = new URL(request.url).searchParams.get("tur") === "pozisyon" ? "pozisyon" : "islem";
  const service = getUserPortfolioService();
  const csv =
    kind === "pozisyon"
      ? positionsCsv(await service.listPositions(actor))
      : ledgerCsv(await service.listLedger(actor));
  const filename = kind === "pozisyon" ? "altin-takip-pozisyonlar.csv" : "altin-takip-islemler.csv";
  return new NextResponse(`\uFEFF${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
