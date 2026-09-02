import { normalizeUsername } from "./username";

/**
 * Kullanıcı adı -> dahili kimlik (e-posta biçimli) eşlemesi.
 *
 * NEDEN: Supabase Auth'un parola ile girişi bir e-posta veya telefon kimliği
 * ister. Ürün gereksinimi ise kullanıcıdan e-posta veya telefon İSTEMEMEK.
 * Çözüm: normalize edilmiş kullanıcı adından deterministik, sunucu tarafında
 * üretilen ve kullanıcıya hiçbir ekranda gösterilmeyen bir dahili adres.
 *
 * KURALLAR
 * - Bu adres hiçbir arayüzde, API yanıtında veya audit log'da gösterilmez.
 * - Bu adrese e-posta gönderilmez; posta kutusu yoktur.
 * - Alan adı varsayılan olarak RFC 2606 ile ayrılmış ".invalid" uzantısını kullanır.
 * - Eşleme deterministiktir: aynı kullanıcı adı her zaman aynı kimliği verir.
 */
export function internalEmailForUsername(username: string, domain: string): string {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    throw new Error("Dahili kimlik üretmek için geçerli bir kullanıcı adı gerekir.");
  }
  const cleanDomain = domain.trim().toLowerCase().replace(/^@+/, "");
  if (!cleanDomain) {
    throw new Error("Dahili kimlik alan adı yapılandırılmamış.");
  }
  return `${normalized}@${cleanDomain}`;
}

/** Dahili adresin yanlışlıkla arayüze sızıp sızmadığını denetlemek için. */
export function looksLikeInternalEmail(value: string, domain: string): boolean {
  return value.toLowerCase().endsWith(`@${domain.trim().toLowerCase()}`);
}
