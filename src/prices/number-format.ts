/**
 * SAYI BİÇİMİ — BELGE DÜZEYİNDE KARAR
 *
 * Neden ayrı bir modül: "6.875,51" ile "6875.51" ile "111.242" aynı karakterleri
 * kullanır ama üçü farklı sayıdır. Tek bir değere bakarak karar vermek
 * kaçınılmaz olarak yanlış fiyat üretir — ölçüldü: Kapalıçarşı tablosunda
 * "6875.51" nokta ONDALIK ayırıcıdır ve Türkçe varsayımıyla okunursa gram altın
 * 687.754 TL görünür.
 *
 * Bu yüzden biçim, TEK bir değere değil kaynağın TAMAMINA bakılarak belirlenir
 * ve kalıplar çelişiyorsa "ambiguous" döner: hiçbir sayı okunmaz.
 *
 * Aynı kurallar hem tarayıcı ekran okuyucusu hem HTML tablo okuyucusu için
 * geçerlidir; iki yerde ayrı ayrı yazılırsa biri diğerinden sapar.
 */

export type NumberFormat = "tr" | "en" | "plain" | "ambiguous";

export function detectNumberFormat(samples: readonly string[]): NumberFormat {
  const values = samples.map((sample) => sample.replace(/[^\d.,]/gu, "")).filter((value) => value !== "");
  if (values.length === 0) return "ambiguous";

  const hasComma = values.some((value) => value.includes(","));
  const hasDot = values.some((value) => value.includes("."));

  if (hasComma && hasDot) {
    // Her iki ayırıcı da varsa Türkçe kabul edilir ancak SIRA tutarlı olmalı:
    // virgül her zaman noktadan SONRA gelmeli ("1.234,56"). Aksi hâlde belirsiz.
    const allTr = values
      .filter((value) => value.includes(",") && value.includes("."))
      .every((value) => value.lastIndexOf(",") > value.lastIndexOf("."));
    return allTr ? "tr" : "ambiguous";
  }
  if (hasComma) return "tr";
  if (hasDot) {
    // Nokta binlik ayırıcı SAYILIR yalnızca noktalı değerlerin HEPSİ
    // "1.234" / "111.242" kalıbına uyuyorsa. "6875.51" uymaz → ondalık nokta.
    const allGrouped = values
      .filter((value) => value.includes("."))
      .every((value) => /^\d{1,3}(\.\d{3})+$/u.test(value));
    return allGrouped ? "tr" : "en";
  }
  return "plain";
}

/** Ham metni, belirlenen biçime göre ondalık DİZEYE çevirir. Kayan nokta yok. */
export function parseScreenNumber(input: string, format: NumberFormat): string | null {
  if (format === "ambiguous") return null;
  if (/[eE]/u.test(input)) return null;
  const cleaned = input.replace(/[^\d.,-]/gu, "").trim();
  if (cleaned === "") return null;

  let normalized: string;
  if (format === "tr") {
    normalized = cleaned.replace(/\./gu, "").replace(",", ".");
  } else if (format === "en") {
    normalized = cleaned.replace(/,/gu, "");
  } else {
    normalized = cleaned;
  }

  if (!/^\d+(\.\d+)?$/u.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return normalized;
}
