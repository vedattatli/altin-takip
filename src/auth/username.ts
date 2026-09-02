/**
 * Kullanıcı adı kuralları ve normalizasyonu.
 *
 * KURALLAR (arayüzde de aynı metinle gösterilir)
 * - Büyük/küçük harf duyarsızdır. "Ayse", "AYSE" ve "ayse" AYNI kullanıcıdır.
 * - Türkçe harfler yazılabilir; ASCII karşılığına çevrilerek saklanır:
 *   ç->c, ğ->g, ı->i, İ->i, ö->o, ş->s, ü->u
 * - Boşluk kullanılamaz. Baştaki ve sondaki boşluklar silinir.
 * - İzin verilen karakterler: a-z, 0-9 ve nokta (.), alt çizgi (_), tire (-)
 * - Harf ile başlamalıdır.
 * - Nokta, alt çizgi veya tire ile bitemez; bunlar art arda gelemez.
 * - Uzunluk: 3-32 karakter (normalize edilmiş hâli).
 *
 * NOT: Kullanıcı adı yalnızca bir tanımlayıcıdır; tek başına kimlik doğrulama
 * unsuru DEĞİLDİR. Giriş için parola zorunludur.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

export const USERNAME_RULES_TR = [
  "3-32 karakter uzunluğunda olmalı.",
  "Küçük harf, rakam ve . _ - karakterleri kullanılabilir.",
  "Harf ile başlamalı; . _ - ile bitmemeli.",
  "Boşluk içeremez.",
  "Türkçe harfler ASCII karşılığına çevrilir (ç->c, ğ->g, ı->i, ö->o, ş->s, ü->u).",
  "Büyük/küçük harf farkı yoktur.",
];

/** Türkçe ve yaygın aksanlı harflerin ASCII karşılıkları. */
const CHAR_MAP: Record<string, string> = {
  ç: "c", Ç: "c",
  ğ: "g", Ğ: "g",
  ı: "i", İ: "i", I: "i", i: "i",
  ö: "o", Ö: "o",
  ş: "s", Ş: "s",
  ü: "u", Ü: "u",
  â: "a", Â: "a",
  î: "i", Î: "i",
  û: "u", Û: "u",
  é: "e", É: "e",
};

/**
 * Kullanıcı adını kanonik (saklanan) biçime çevirir.
 * Doğrulama yapmaz; yalnızca dönüştürür. Geçerlilik için validateUsername kullanın.
 */
export function normalizeUsername(raw: string): string {
  const mapped = Array.from(raw.trim())
    .map((char) => CHAR_MAP[char] ?? char)
    .join("");

  // NFKD sonrası kalan birleştirici işaretleri (aksanları) at.
  const withoutMarks = Array.from(mapped.normalize("NFKD"))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x0300 || code > 0x036f;
    })
    .join("");

  return withoutMarks.toLowerCase();
}

export interface UsernameValidation {
  ok: boolean;
  /** Normalize edilmiş kullanıcı adı. Geçersizse boş dize. */
  value: string;
  error: string | null;
}

export function validateUsername(raw: string): UsernameValidation {
  const value = normalizeUsername(raw ?? "");
  const fail = (error: string): UsernameValidation => ({ ok: false, value: "", error });

  if (value.length === 0) return fail("Kullanıcı adı boş olamaz.");
  if (/\s/.test(value)) return fail("Kullanıcı adı boşluk içeremez.");
  if (value.length < USERNAME_MIN_LENGTH) {
    return fail(`Kullanıcı adı en az ${USERNAME_MIN_LENGTH} karakter olmalıdır.`);
  }
  if (value.length > USERNAME_MAX_LENGTH) {
    return fail(`Kullanıcı adı en fazla ${USERNAME_MAX_LENGTH} karakter olabilir.`);
  }
  if (!/^[a-z]/.test(value)) return fail("Kullanıcı adı bir harf ile başlamalıdır.");
  if (!/^[a-z0-9._-]+$/.test(value)) {
    return fail("Kullanıcı adı yalnızca harf, rakam ve . _ - karakterlerini içerebilir.");
  }
  if (/[._-]$/.test(value)) return fail("Kullanıcı adı . _ - karakteriyle bitemez.");
  if (/[._-]{2,}/.test(value)) return fail("Kullanıcı adında . _ - karakterleri art arda gelemez.");

  return { ok: true, value, error: null };
}

/** Uygulamanın kendi kullanımı için ayrılmış adlar. */
const RESERVED = new Set(["root", "system", "support", "api", "null", "undefined"]);

export function isReservedUsername(normalized: string): boolean {
  return RESERVED.has(normalized);
}
