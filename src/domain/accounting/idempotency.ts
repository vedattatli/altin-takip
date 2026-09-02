import type { LedgerAppendRequest } from "./types";

/**
 * IDEMPOTENCY PARMAK İZİ — tek kanonik semantik.
 *
 * Aynı clientRequestId ile gelen isteğin içeriği bu parmak iziyle karşılaştırılır:
 *   aynı içerik  -> replay (mevcut sonuç, tek finansal işlem)
 *   farklı içerik -> ALTIN_IDEMPOTENCY_CONFLICT
 * Sunucu (Postgres `md5(payload - client_request_id - baseline_snapshot - created_by)`),
 * yerel geliştirme arka ucu ve demo depoları (IndexedDB / bellek) aynı alan kümesini
 * kullanır: kimlik, anlık görüntü ve oluşturan hariç bütün girdiler.
 */

export function canonicalRequestPayload(request: LedgerAppendRequest): string {
  const { clientRequestId: _id, baselineSnapshot: _snapshot, ...rest } = request;
  const sorted = Object.fromEntries(
    Object.entries(rest)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify(sorted);
}

/** FNV-1a (32 bit) × 2 farklı tohum → 16 hex karakter. Kriptografik değil; içerik eşitliği için yeterli. */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function requestFingerprint(request: LedgerAppendRequest): string {
  const canonical = canonicalRequestPayload(request);
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9747b28c)}`;
}
