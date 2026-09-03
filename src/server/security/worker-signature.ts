import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * KALICI WORKER İMZASI (HMAC-SHA256)
 *
 * Tarayıcı worker'ı Supabase service_role anahtarını ALMAZ. Yalnızca uygulamanın
 * özel makine ucuna yazar ve her isteği paylaşılan bir secret ile imzalar.
 *
 * İmzalanan dize (satır sonu ayraçlı, sıralaması sabit):
 *
 *   timestamp \n nonce \n bodySha256 \n workerId
 *
 * Neden gövde HASH'i imzalanıyor: gövdenin tamamını imzaya sokmak yerine özetini
 * imzalamak, gövde büyüdükçe imza maliyetini sabit tutar ve gövdenin tek bayt
 * değişmesini bile yakalar.
 *
 * Sunucu tarafı kontroller (hepsi zorunlu):
 *   - secret tanımlı olmalı (yoksa uç KAPALI)
 *   - timestamp toleransı en fazla 60 saniye (eski istek reddedilir)
 *   - nonce tek kullanımlık (replay reddedilir)
 *   - gövde hash'i gerçekten gövdenin hash'i olmalı
 *   - imza sabit sürede karşılaştırılır
 */

export const WORKER_TIMESTAMP_TOLERANCE_MS = 60_000;

export interface WorkerSignatureHeaders {
  workerId: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  signature: string;
  workerVersion: string;
}

export type WorkerVerifyFailure =
  | "MISSING_SECRET"
  | "MISSING_HEADERS"
  | "TIMESTAMP_INVALID"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "BODY_HASH_MISMATCH"
  | "SIGNATURE_MISMATCH";

export type WorkerVerifyResult = { ok: true; headers: WorkerSignatureHeaders } | { ok: false; code: WorkerVerifyFailure };

/** İstek başlıklarını okur; eksikse null döner. */
export function readWorkerHeaders(request: Request): WorkerSignatureHeaders | null {
  const workerId = request.headers.get("x-worker-id")?.trim() ?? "";
  const timestamp = request.headers.get("x-worker-timestamp")?.trim() ?? "";
  const nonce = request.headers.get("x-worker-nonce")?.trim() ?? "";
  const bodySha256 = request.headers.get("x-worker-body-sha256")?.trim() ?? "";
  const signature = request.headers.get("x-worker-signature")?.trim() ?? "";
  const workerVersion = request.headers.get("x-worker-version")?.trim() ?? "";
  if (workerId === "" || timestamp === "" || nonce === "" || bodySha256 === "" || signature === "") return null;
  return { workerId, timestamp, nonce, bodySha256, signature, workerVersion };
}

/** İmzalanacak kanonik dize. Worker ve sunucu AYNI biçimi kullanmak zorundadır. */
export function signingPayload(headers: Pick<WorkerSignatureHeaders, "timestamp" | "nonce" | "bodySha256" | "workerId">): string {
  return [headers.timestamp, headers.nonce, headers.bodySha256, headers.workerId].join("\n");
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function signWorkerRequest(
  headers: Pick<WorkerSignatureHeaders, "timestamp" | "nonce" | "bodySha256" | "workerId">,
  secret: string,
): string {
  return createHmac("sha256", secret).update(signingPayload(headers), "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * İmzayı doğrular. Nonce tüketimi ÇAĞIRANIN sorumluluğundadır: bu fonksiyon
 * saf ve yan etkisizdir, böylece testlerde tek başına kullanılabilir.
 */
export function verifyWorkerSignature(
  headers: WorkerSignatureHeaders | null,
  rawBody: string,
  secret: string | undefined,
  now: number,
): WorkerVerifyResult {
  const trimmedSecret = (secret ?? "").trim();
  if (trimmedSecret === "") return { ok: false, code: "MISSING_SECRET" };
  if (!headers) return { ok: false, code: "MISSING_HEADERS" };

  const timestampMs = Date.parse(headers.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, code: "TIMESTAMP_INVALID" };
  if (Math.abs(now - timestampMs) > WORKER_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, code: "TIMESTAMP_OUT_OF_RANGE" };
  }

  const actualHash = sha256Hex(rawBody);
  if (!constantTimeEqual(actualHash, headers.bodySha256.toLowerCase())) {
    return { ok: false, code: "BODY_HASH_MISMATCH" };
  }

  const expected = signWorkerRequest(headers, trimmedSecret);
  if (!constantTimeEqual(expected, headers.signature.toLowerCase())) {
    return { ok: false, code: "SIGNATURE_MISMATCH" };
  }
  return { ok: true, headers };
}
