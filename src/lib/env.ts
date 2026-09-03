/**
 * ORTAM DEĞİŞKENİ OKUMA — SESSİZ SIFIRA DÜŞME YASAĞI
 *
 * `Number(process.env.X ?? "0.15")` kalıbı tehlikelidir: `??` yalnızca
 * `undefined` ve `null` için devreye girer. Değişken TANIMLI ama BOŞ ise
 * (`PRICE_MAX_TRY=` gibi) varsayılan kullanılmaz ve `Number("")` **0** döner.
 *
 * Bunun sonucu sessiz ve tehlikelidir: örneğin fiyat üst sınırı 0 olur ve
 * kalite kapısı bütün fiyatları reddeder; ya da bir eşik 0'a düşüp kontrolü
 * fiilen devre dışı bırakır. Hiçbiri log üretmez.
 *
 * Bu yüzden sayısal ayarlar buradan okunur: boş/boşluk değer "ayarlanmamış"
 * sayılır, geçersiz değer varsayılana düşer.
 */

/** Ayarlanmamış sayılan değerler: yok, boş veya yalnızca boşluk. */
function rawOrNull(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Sayısal ayar okur.
 *
 * @param name Ortam değişkeni adı.
 * @param fallback Ayarlanmamış veya geçersizse kullanılacak değer.
 * @param options.min Kabul edilen en küçük değer (dâhil). Altındaysa fallback.
 * @param options.max Kabul edilen en büyük değer (dâhil). Üstündeyse fallback.
 */
export function numberFromEnv(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = rawOrNull(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return fallback;
  if (options.max !== undefined && parsed > options.max) return fallback;
  return parsed;
}

/**
 * Metin ayarı okur. Boş değer "ayarlanmamış" sayılır ve `fallback` döner.
 * Böylece boş bir değişken, adı hiç yazılmamış gibi davranır.
 */
export function stringFromEnv(name: string, fallback: string): string {
  return rawOrNull(name) ?? fallback;
}

/** Bayrak okur; yalnızca "true" (harf durumu önemsiz) doğru sayılır. */
export function flagFromEnv(name: string, fallback = false): boolean {
  const raw = rawOrNull(name);
  if (raw === null) return fallback;
  return raw.toLowerCase() === "true";
}
