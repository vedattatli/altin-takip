import { NextResponse } from "next/server";

import { getAuthBackend, getPriceIngestionService } from "@/server/auth";
import { ok } from "@/server/http";
import { timingSafeEqualString } from "@/server/security/csrf";
import { apiRoute } from "@/server/security/route";

/**
 * SAĞLIK KONTROLÜ
 *
 * İki seviyelidir:
 *
 * 1. Kimliksiz (herkese açık): yalnızca "uygulama ayakta mı, veritabanına
 *    ulaşabiliyor mu" sorusunu yanıtlar. Kullanıcı sayısı, sağlayıcı adı,
 *    sürüm, ortam değişkeni veya secret DÖNMEZ. İzleme servisleri bunu kullanır.
 *
 * 2. `PRICE_CRON_SECRET` ile: fiyat sağlayıcılarının sağlık özetini de ekler
 *    (durum, kapsam, karantina sayısı, güvenli hata kodu). Ham payload, adres
 *    ve anahtar hiçbir seviyede dönmez.
 *
 * Yanıt her zaman `no-store`'dur; sağlık verisi önbelleğe alınmaz.
 */
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store" } as const;

function detailAuthorized(request: Request): boolean {
  const secret = (process.env.PRICE_CRON_SECRET ?? "").trim();
  if (secret === "") return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const custom = (request.headers.get("x-cron-secret") ?? "").trim();
  return timingSafeEqualString(bearer, secret) || timingSafeEqualString(custom, secret);
}

export const GET = apiRoute(async (request) => {
  const checkedAt = new Date().toISOString();
  let databaseOk = false;
  try {
    await getAuthBackend().ensureReady();
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  if (!detailAuthorized(request)) {
    // Kimliksiz yanıt kasten yalındır: iç durum sızdırmaz.
    return NextResponse.json(
      { data: { status: databaseOk ? "ok" : "degraded", checkedAt } },
      { status: databaseOk ? 200 : 503, headers: HEADERS },
    );
  }

  let providers: {
    providerCode: string;
    licenseStatus: string;
    enabled: boolean;
    health: string | null;
    lastSuccessAt: string | null;
    coverage: number;
    quarantined: number;
    safeErrorCode: string | null;
  }[] = [];
  try {
    const ingestion = getPriceIngestionService();
    await ingestion.ensureCatalog();
    providers = (await getAuthBackend().listPriceProviders()).map((row) => ({
      providerCode: row.code,
      licenseStatus: row.licenseStatus,
      enabled: row.enabled,
      health: row.health?.status ?? null,
      lastSuccessAt: row.health?.lastSuccessAt ?? null,
      coverage: row.health?.coverageCount ?? 0,
      quarantined: row.health?.quarantinedCount ?? 0,
      safeErrorCode: row.health?.safeErrorCode ?? null,
    }));
  } catch {
    providers = [];
  }

  return ok(
    { status: databaseOk ? "ok" : "degraded", checkedAt, database: databaseOk ? "ok" : "error", providers },
    { headers: HEADERS },
  );
});
