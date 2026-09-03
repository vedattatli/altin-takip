import { NextResponse } from "next/server";

import { getPriceIngestionService } from "@/server/auth";
import { ok } from "@/server/http";
import { timingSafeEqualString } from "@/server/security/csrf";
import { apiRoute } from "@/server/security/route";

/**
 * Zamanlanmış fiyat alımı.
 *
 * - Secret ile korunur (`PRICE_CRON_SECRET`); yoksa uç KAPALIDIR (fail closed).
 * - Idempotenttir: aynı koşum anahtarı iki kez uygulanmaz.
 * - Yalnızca etkin ve lisanslı sağlayıcılar çekilir; test sağlayıcısı üretimde çalışmaz.
 * - Yanıt secret veya ham payload İÇERMEZ.
 */
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = (process.env.PRICE_CRON_SECRET ?? "").trim();
  if (secret === "") return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const custom = (request.headers.get("x-cron-secret") ?? "").trim();
  // Sabit süreli karşılaştırma: secret uzunluğu/önekі zamanlama ile sızmaz.
  return timingSafeEqualString(bearer, secret) || timingSafeEqualString(custom, secret);
}

export const POST = apiRoute(async (request) => {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: "Bu uç yalnızca zamanlanmış görev tarafından çağrılabilir.", code: "forbidden" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const service = getPriceIngestionService();
  await service.syncCatalog();
  const outcomes = await service.ingestEnabled();
  return ok(
    {
      providers: outcomes.map((outcome) => ({
        providerCode: outcome.providerCode,
        attempted: outcome.attempted,
        status: outcome.result?.status ?? "SKIPPED",
        accepted: outcome.accepted,
        quarantined: outcome.quarantined.length,
        safeErrorCode: outcome.safeErrorCode,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
