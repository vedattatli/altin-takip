import {
  screenLabelToProduct,
  unmappedReason,
  type MappingConfidence,
} from "../../../src/prices/providers/sarraf-tv-screen-mapping";

/**
 * EKRAN OKUMA (saf fonksiyonlar)
 *
 * Tarayıcıdan alınan ham satırları kanonik ürünlere çevirir. Kurallar:
 *  - Alış/satış yönü SÜTUN BAŞLIĞINDAN doğrulanır; sıra numarasına güvenilmez.
 *    Başlığı olmayan (tek fiyatlı) satır yön doğrulanamadığı için ATLANIR.
 *  - Başlık eşlenemezse ürün ATLANIR (unresolved), tahmin yapılmaz.
 *  - Yeni/eski ayrımı yazmayan başlıklar ayrı "CONVENTION" güveniyle işaretlenir.
 *  - Sayı biçimi BELGE DÜZEYİNDE belirlenir; satır satır tahmin edilmez.
 */

export interface RawScreenRow {
  /** Ekranda görünen ürün başlığı. */
  label: string;
  /** Sütun başlığı → hücre metni. Tek fiyatlı satırlarda başlık bulunmaz. */
  cells: Record<string, string>;
}

export interface ExtractedQuote {
  rawProductName: string;
  canonicalProductId: string;
  mappingConfidence: MappingConfidence;
  rawBuyLabel: string;
  rawSellLabel: string;
  liquidationPrice: string;
  replacementPrice: string;
  extractionMethod: string;
}

export interface UnresolvedRow {
  rawProductName: string;
  reason: string;
}

const BUY_HEADERS = ["alış", "alis", "alış fiyatı", "alım"];
const SELL_HEADERS = ["satış", "satis", "satış fiyatı", "satım"];

/** Türkçe yerel: "ALIŞ" → "alış" (varsayılan yerel "aliş" üretir ve eşleşmez). */
function normalize(text: string): string {
  return text.trim().toLocaleLowerCase("tr-TR").replace(/\s+/gu, " ");
}

/** Sütun başlığından alış mı satış mı olduğunu belirler. */
export function classifyHeader(header: string): "buy" | "sell" | null {
  const value = normalize(header);
  if (BUY_HEADERS.some((candidate) => value === candidate || value.startsWith(`${candidate} `))) return "buy";
  if (SELL_HEADERS.some((candidate) => value === candidate || value.startsWith(`${candidate} `))) return "sell";
  return null;
}

export type NumberFormat = "tr" | "en" | "plain" | "ambiguous";

/**
 * Sayı biçimini BELGE DÜZEYİNDE belirler.
 *
 * "6.871" tek başına belirsizdir (6871 mi, 6,871 mi?). Ama ekrandaki BÜTÜN
 * sayılar `1.234` / `224.150` kalıbına uyuyor ve hiçbirinde ondalık virgül
 * yoksa, nokta binlik ayırıcıdır — bu, tek bir değere bakarak değil, belgenin
 * tamamına bakarak verilen bir karardır. Kalıplar karışıksa "ambiguous" döner
 * ve hiçbir sayı okunmaz.
 */
export function detectNumberFormat(samples: readonly string[]): NumberFormat {
  const values = samples.map((sample) => sample.replace(/[^\d.,]/gu, "")).filter((value) => value !== "");
  if (values.length === 0) return "ambiguous";

  const hasComma = values.some((value) => value.includes(","));
  const hasDot = values.some((value) => value.includes("."));

  if (hasComma && hasDot) {
    // Karışık: "1.234,56" (tr) hepsinde aynı sırayla mı?
    const allTr = values
      .filter((value) => value.includes(",") && value.includes("."))
      .every((value) => value.lastIndexOf(",") > value.lastIndexOf("."));
    return allTr ? "tr" : "ambiguous";
  }
  if (hasComma) return "tr";
  if (hasDot) {
    // Yalnızca nokta var: her nokta tam üç basamak grubu ayırıyorsa binliktir.
    const allGrouped = values
      .filter((value) => value.includes("."))
      .every((value) => /^\d{1,3}(\.\d{3})+$/u.test(value));
    return allGrouped ? "tr" : "en";
  }
  return "plain";
}

/** Ekrandaki sayıyı, belirlenen biçime göre ondalık dizeye çevirir. */
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

export interface ExtractionResult {
  quotes: ExtractedQuote[];
  unresolved: UnresolvedRow[];
  numberFormat: NumberFormat;
}

/** Ham satırları kanonik quote'lara çevirir. */
export function extractQuotes(rows: readonly RawScreenRow[], extractionMethod: string): ExtractionResult {
  const samples = rows.flatMap((row) => Object.values(row.cells));
  const numberFormat = detectNumberFormat(samples);
  const quotes: ExtractedQuote[] = [];
  const unresolved: UnresolvedRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const mapped = screenLabelToProduct(row.label);
    if (!mapped) {
      unresolved.push({
        rawProductName: row.label,
        reason: unmappedReason(row.label) ?? "ÜRÜN_EŞLENEMEDİ",
      });
      continue;
    }
    if (seen.has(mapped.productId)) {
      unresolved.push({ rawProductName: row.label, reason: "AYNI_ÜRÜN_İKİ_KEZ" });
      continue;
    }

    let buyHeader: string | null = null;
    let sellHeader: string | null = null;
    for (const header of Object.keys(row.cells)) {
      const kind = classifyHeader(header);
      if (kind === "buy" && buyHeader === null) buyHeader = header;
      if (kind === "sell" && sellHeader === null) sellHeader = header;
    }
    if (buyHeader === null || sellHeader === null) {
      // Yön sütun başlığından doğrulanamıyorsa sıraya GÜVENİLMEZ; satır atlanır.
      unresolved.push({ rawProductName: row.label, reason: "ALIŞ_SATIŞ_BAŞLIĞI_YOK" });
      continue;
    }

    const liquidationPrice = parseScreenNumber(row.cells[buyHeader] ?? "", numberFormat);
    const replacementPrice = parseScreenNumber(row.cells[sellHeader] ?? "", numberFormat);
    if (!liquidationPrice || !replacementPrice) {
      unresolved.push({ rawProductName: row.label, reason: "SAYI_OKUNAMADI" });
      continue;
    }
    if (Number(replacementPrice) < Number(liquidationPrice)) {
      // Ekranda satış < alış görünüyorsa sütunlar ters olabilir: DÜZELTİLMEZ, atlanır.
      unresolved.push({ rawProductName: row.label, reason: "MAKAS_TERS" });
      continue;
    }

    seen.add(mapped.productId);
    quotes.push({
      rawProductName: row.label,
      canonicalProductId: mapped.productId,
      mappingConfidence: mapped.confidence,
      rawBuyLabel: buyHeader,
      rawSellLabel: sellHeader,
      liquidationPrice,
      replacementPrice,
      extractionMethod,
    });
  }

  return { quotes, unresolved, numberFormat };
}

/** İki gözlem arasında birebir eşleşmeyen ürünleri bulur. */
export function compareSnapshots(
  a: readonly ExtractedQuote[],
  b: readonly ExtractedQuote[],
): { productId: string; field: string; a: string; b: string }[] {
  const byId = new Map(b.map((quote) => [quote.canonicalProductId, quote]));
  const diffs: { productId: string; field: string; a: string; b: string }[] = [];
  for (const quote of a) {
    const other = byId.get(quote.canonicalProductId);
    if (!other) {
      diffs.push({ productId: quote.canonicalProductId, field: "varlık", a: "var", b: "yok" });
      continue;
    }
    if (quote.liquidationPrice !== other.liquidationPrice) {
      diffs.push({
        productId: quote.canonicalProductId,
        field: "liquidationPrice",
        a: quote.liquidationPrice,
        b: other.liquidationPrice,
      });
    }
    if (quote.replacementPrice !== other.replacementPrice) {
      diffs.push({
        productId: quote.canonicalProductId,
        field: "replacementPrice",
        a: quote.replacementPrice,
        b: other.replacementPrice,
      });
    }
  }
  return diffs;
}

/**
 * EKRAN ↔ JSON DOĞRULAMASI
 *
 * Çıkarılan her fiyatın ekranda GÖRÜNEN metinde birebir bulunduğunu denetler.
 * Sayı biçimi ekranda yerel (ör. "10.850"), JSON'da kanonik ("10850") olduğu
 * için karşılaştırma ham ekran metni üzerinden yapılır.
 */
export function verifyAgainstScreenText(
  quotes: readonly ExtractedQuote[],
  rows: readonly RawScreenRow[],
): { productId: string; field: string; expected: string; screen: string }[] {
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  const mismatches: { productId: string; field: string; expected: string; screen: string }[] = [];
  for (const quote of quotes) {
    const row = byLabel.get(quote.rawProductName);
    if (!row) {
      mismatches.push({
        productId: quote.canonicalProductId,
        field: "satır",
        expected: quote.rawProductName,
        screen: "(bulunamadı)",
      });
      continue;
    }
    const buyText = row.cells[quote.rawBuyLabel] ?? "";
    const sellText = row.cells[quote.rawSellLabel] ?? "";
    const format = detectNumberFormat(Object.values(row.cells));
    if (parseScreenNumber(buyText, format) !== quote.liquidationPrice) {
      mismatches.push({
        productId: quote.canonicalProductId,
        field: "liquidationPrice",
        expected: quote.liquidationPrice,
        screen: buyText,
      });
    }
    if (parseScreenNumber(sellText, format) !== quote.replacementPrice) {
      mismatches.push({
        productId: quote.canonicalProductId,
        field: "replacementPrice",
        expected: quote.replacementPrice,
        screen: sellText,
      });
    }
  }
  return mismatches;
}
