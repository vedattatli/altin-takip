import { NextResponse } from "next/server";

import { getAuthBackend } from "@/server/auth";
import { ScreenWorkerService, SCREEN_PROVIDER_CODE } from "@/server/prices/screen-worker-service";
import type { ScreenWorkerPayload } from "@/server/prices/types";
import { readWorkerHeaders, verifyWorkerSignature } from "@/server/security/worker-signature";

/**
 * KALICI EKRAN WORKER'I İÇİN İMZALI MAKİNE UCU
 *
 * Worker Supabase service_role anahtarını BİLMEZ; yalnızca buraya yazar.
 *
 * Doğrulama sırası (hepsi fail closed):
 *   1. Gövde boyutu ve içerik türü
 *   2. HMAC imzası (timestamp toleransı + gövde hash'i + sabit süreli karşılaştırma)
 *   3. Nonce tek kullanımlık (replay reddi)
 *   4. Kira jetonu (aynı anda tek worker; devralınmış kira eskimiş sayılır)
 *   5. Merkezî kalite kapısı ve eşleme onayları (servis katmanında)
 *
 * Sağlayıcı kimliği SUNUCUDA sabitlenir; gövdeden okunmaz.
 * Yanıt secret, ham tarayıcı cevabı veya adres İÇERMEZ.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const HEADERS = { "Cache-Control": "private, no-store" } as const;

function deny(code: string, status = 403): NextResponse {
  return NextResponse.json({ error: "Worker isteği reddedildi.", code }, { status, headers: HEADERS });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return deny("content_type", 415);

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return deny("body_too_large", 413);

    const headers = readWorkerHeaders(request);
    const verified = verifyWorkerSignature(
      headers,
      rawBody,
      process.env.PRICE_SCREEN_WORKER_SECRET,
      Date.now(),
    );
    if (!verified.ok) return deny(verified.code.toLowerCase());

    const leaseToken = request.headers.get("x-worker-lease-token")?.trim() ?? "";
    if (leaseToken === "") return deny("missing_lease_token");

    const backend = getAuthBackend();
    const claimed = await backend.claimWorkerNonce(verified.headers.nonce, verified.headers.workerId);
    if (!claimed) return deny("nonce_replay", 409);

    let payload: ScreenWorkerPayload;
    try {
      payload = JSON.parse(rawBody) as ScreenWorkerPayload;
    } catch {
      return deny("invalid_json", 400);
    }
    if (typeof payload !== "object" || payload === null || !Array.isArray(payload.observations)) {
      return deny("invalid_payload", 400);
    }
    // Worker kimliği başlıktan gelir; gövdedeki değere güvenilmez.
    payload.workerId = verified.headers.workerId;

    const service = new ScreenWorkerService(backend);
    // Koşum anahtarı sunucuda üretilir: worker kendi anahtarını dayatamaz.
    const runKey = `${SCREEN_PROVIDER_CODE}:${verified.headers.nonce}`;
    const result = await service.ingest(payload, leaseToken, runKey);
    if (!result.ok) return deny((result.failure ?? "rejected").toLowerCase(), 409);

    return NextResponse.json(
      {
        data: {
          status: result.status,
          accepted: result.accepted,
          quarantined: result.quarantined,
          unresolved: result.unresolved,
          message: result.message,
        },
      },
      { status: 200, headers: HEADERS },
    );
  } catch {
    // İç hata ayrıntısı sızdırılmaz.
    return NextResponse.json(
      { error: "Worker isteği işlenemedi.", code: "worker_error" },
      { status: 500, headers: HEADERS },
    );
  }
}
