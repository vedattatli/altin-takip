import { NextResponse } from "next/server";

import { getAuthBackend } from "@/server/auth";
import { ScreenWorkerService } from "@/server/prices/screen-worker-service";
import { readWorkerHeaders, verifyWorkerSignature } from "@/server/security/worker-signature";

/**
 * WORKER KİRASI
 *
 * Worker, gözlem göndermeden önce buradan kirayı alır veya yeniler ve dönen
 * jetonu her gönderide taşır. Aynı sağlayıcı için AYNI ANDA yalnızca bir worker
 * kirayı tutabilir; kira süresi dolarsa başka worker devralır ve eski jeton
 * geçersiz olur (fencing).
 *
 * Kimlik doğrulama, gözlem ucuyla AYNI HMAC şemasını kullanır.
 */
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store" } as const;
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Gövde çok büyük.", code: "body_too_large" }, { status: 413, headers: HEADERS });
    }
    const headers = readWorkerHeaders(request);
    const verified = verifyWorkerSignature(headers, rawBody, process.env.PRICE_SCREEN_WORKER_SECRET, Date.now());
    if (!verified.ok) {
      return NextResponse.json(
        { error: "Worker isteği reddedildi.", code: verified.code.toLowerCase() },
        { status: 403, headers: HEADERS },
      );
    }

    const backend = getAuthBackend();
    const claimed = await backend.claimWorkerNonce(verified.headers.nonce, verified.headers.workerId);
    if (!claimed) {
      return NextResponse.json(
        { error: "Worker isteği reddedildi.", code: "nonce_replay" },
        { status: 409, headers: HEADERS },
      );
    }

    const service = new ScreenWorkerService(backend);
    const lease = await service.acquireLease(verified.headers.workerId);
    return NextResponse.json(
      { data: { held: lease.held, leaseToken: lease.leaseToken, takeover: lease.takeover } },
      { status: lease.held ? 200 : 409, headers: HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: "Kira alınamadı.", code: "worker_error" },
      { status: 500, headers: HEADERS },
    );
  }
}
