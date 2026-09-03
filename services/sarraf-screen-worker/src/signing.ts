import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * WORKER İMZASI
 *
 * Sunucudaki `src/server/security/worker-signature.ts` ile AYNI kanonik biçimi
 * üretir. Worker "server-only" modülleri içe aktaramadığı için algoritma burada
 * ikinci kez yazılır; iki tarafın uyumu `tests/price-runtime.test.ts` içinde
 * doğrulanır (imza uyuşmazsa test kırılır).
 *
 * İmzalanan dize:
 *   timestamp \n nonce \n bodySha256 \n workerId
 */

export interface SignedRequest {
  headers: Record<string, string>;
  body: string;
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function signingPayload(input: {
  timestamp: string;
  nonce: string;
  bodySha256: string;
  workerId: string;
}): string {
  return [input.timestamp, input.nonce, input.bodySha256, input.workerId].join("\n");
}

/** Gövdeyi imzalar ve gönderilecek başlıkları üretir. */
export function signRequest(options: {
  body: string;
  workerId: string;
  workerVersion: string;
  secret: string;
  leaseToken?: string | null;
  now?: () => number;
}): SignedRequest {
  const timestamp = new Date(options.now?.() ?? Date.now()).toISOString();
  const nonce = randomUUID();
  const bodySha256 = sha256Hex(options.body);
  const signature = createHmac("sha256", options.secret)
    .update(signingPayload({ timestamp, nonce, bodySha256, workerId: options.workerId }), "utf8")
    .digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Worker-Id": options.workerId,
    "X-Worker-Timestamp": timestamp,
    "X-Worker-Nonce": nonce,
    "X-Worker-Body-SHA256": bodySha256,
    "X-Worker-Signature": signature,
    "X-Worker-Version": options.workerVersion,
  };
  if (options.leaseToken) headers["X-Worker-Lease-Token"] = options.leaseToken;
  return { headers, body: options.body };
}
