/**
 * CSRF ve same-origin koruması.
 *
 * YÖNTEM: imzalı senkronizasyon jetonu (signed synchronizer token).
 *
 *  1. Sunucu rastgele bir değer üretir ve `<değer>.<HMAC(değer)>` biçiminde
 *     HttpOnly bir çerezde saklar. İmza AUTH_CSRF_SECRET ile atılır.
 *  2. Aynı rastgele değer, sayfaya <meta name="csrf-token"> olarak basılır.
 *  3. İstemci bu değeri X-CSRF-Token başlığında geri gönderir.
 *  4. Sunucu imzayı doğrular ve başlıktaki değerin çerezdekiyle eşleştiğini kontrol eder.
 *
 * Jeton localStorage/sessionStorage'a YAZILMAZ ve çerez HttpOnly olduğu için
 * document.cookie ile de okunamaz. Bu, klasik double-submit'ten daha güçlüdür:
 * saldırgan bir alt alan adından çerez yazsa bile geçerli imza üretemez.
 *
 * Web Crypto kullanılır; böylece hem Node hem Edge (proxy) çalışma
 * zamanında aynı kod çalışır.
 */

export const CSRF_HEADER = "x-csrf-token";
/** Proxy katmanının sunucu bileşenlerine jetonu iletmek için kullandığı başlık. */
export const CSRF_REQUEST_HEADER = "x-altin-csrf-token";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

/** Sabit süreli karşılaştırma — zamanlama sızıntısını engeller. */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

/** Çerezde saklanacak imzalı jetonu üretir. */
export async function createSignedCsrfCookie(
  secret: string,
): Promise<{ token: string; cookieValue: string }> {
  const token = randomToken();
  const signature = await sign(token, secret);
  return { token, cookieValue: `${token}.${signature}` };
}

/** Çerez değerinin imzasını doğrular ve ham jetonu döner. */
export async function readSignedCsrfCookie(
  cookieValue: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!cookieValue) return null;
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return null;

  const token = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = await sign(token, secret);
  return timingSafeEqual(signature, expected) ? token : null;
}

/** Başlıktaki jetonun çerezdekiyle eşleştiğini doğrular. */
export async function verifyCsrf(
  cookieValue: string | undefined,
  headerValue: string | null,
  secret: string,
): Promise<boolean> {
  if (!headerValue) return false;
  const token = await readSignedCsrfCookie(cookieValue, secret);
  if (!token) return false;
  return timingSafeEqual(token, headerValue);
}

/** Durum değiştiren yöntemler — CSRF ve origin kontrolü bunlara uygulanır. */
export const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Origin ve Sec-Fetch-Site kontrolü.
 *
 * - Origin başlığı beklenen origin ile birebir eşleşmelidir.
 * - Sec-Fetch-Site yalnızca "same-origin" veya "none" olabilir.
 *   ("cross-site" ve "same-site" reddedilir; alt alan adından gelen istek de kabul edilmez.)
 */
export function checkOrigin(
  headers: { get(name: string): string | null },
  expectedOrigins: readonly string[],
): OriginCheckResult {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, reason: `sec-fetch-site=${fetchSite}` };
  }

  const origin = headers.get("origin");
  if (!origin) {
    // Origin yoksa Sec-Fetch-Site'e güvenilir; ikisi birden yoksa reddedilir.
    if (fetchSite === "same-origin" || fetchSite === "none") return { ok: true };
    return { ok: false, reason: "origin-missing" };
  }

  if (!expectedOrigins.includes(origin)) {
    return { ok: false, reason: "origin-mismatch" };
  }
  return { ok: true };
}
