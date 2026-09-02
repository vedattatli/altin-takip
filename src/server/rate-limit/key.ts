import { createHmac } from "node:crypto";

/**
 * Hız sınırlayıcı anahtarının gizlenmesi.
 *
 * Ham anahtar "IP|kullanıcı adı" biçimindedir ve kişisel veridir. Hiçbir
 * depoda ham hâliyle tutulmaz: RATE_LIMIT_PEPPER ile HMAC-SHA256'dan geçirilir.
 * Pepper değişirse eski sayaçlar doğal olarak geçersiz olur (kabul edilebilir).
 */
export function hashRateLimitKey(key: string, pepper: string): string {
  if (!pepper) {
    throw new Error("RATE_LIMIT_PEPPER tanımlı değil; hız sınırlayıcı anahtarı gizlenemez.");
  }
  return createHmac("sha256", pepper).update(key).digest("hex");
}
