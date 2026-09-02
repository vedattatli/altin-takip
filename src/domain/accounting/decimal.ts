import Decimal from "decimal.js";

/**
 * KESİN SAYISAL HESAPLAMA
 *
 * Finansal hesaplarda JavaScript `number` (ikili kayan nokta) KULLANILMAZ.
 * Bütün miktar ve para değerleri API'de ondalık DİZE olarak taşınır, domain
 * motorunda decimal.js ile işlenir ve veritabanında `numeric` olarak saklanır.
 *
 * Yuvarlama politikası (bkz. docs/ACCOUNTING_MODEL.md):
 *  - Ara adımlarda yuvarlama yapılmaz.
 *  - Satışta çıkarılan maliyet (removed_cost_basis), ortalama maliyet ve bilgi amaçlı
 *    efektif birim değerler yalnızca deftere yazılırken 8 ondalığa HALF_UP yuvarlanır.
 *  - Arayüz TL'yi 2 ondalıkla gösterir; bu yalnızca biçimlendirmedir.
 */
export const AccountingDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  // Hiçbir zaman bilimsel gösterim üretme ("1e+21" gibi değerler API'ye çıkmaz).
  toExpNeg: -30,
  toExpPos: 60,
});

export type Dec = InstanceType<typeof AccountingDecimal>;

/** Para tutarlarının deftere yazılırken yuvarlandığı ondalık basamak. */
export const MONEY_SCALE = 8;
/** Gram miktarlarında desteklenen en yüksek ondalık basamak. */
export const QUANTITY_SCALE = 6;
/** Arayüzde TL için gösterilen ondalık basamak. */
export const DISPLAY_MONEY_SCALE = 2;

/** Tutarlar için kabul edilen üst sınır (tam sayı basamak). Aşırı büyük değerler reddedilir. */
export const MAX_INTEGER_DIGITS = 12;

const DECIMAL_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/*
 * KABUL EDİLEN YAZIMLAR (istemci ve sunucuda AYNI kurallar):
 *   "12"            tam sayı
 *   "12,5"          virgül = ondalık ayırıcı (Türkçe)
 *   "12.5"          nokta = ondalık ayırıcı (kanonik API biçimi)
 *   "1.234,56"      nokta = binlik, virgül = ondalık (Türkçe gruplu)
 *   "1.234.567"     iki veya daha fazla üçlü grup: binlik ayırıcı (belirsizlik yok)
 * REDDEDİLENLER:
 *   "1 2"           sayının içinde boşluk (yanlışlıkla eklenen karakter 12'ye dönüşmez)
 *   "5.000"         BELİRSİZ: 5 mi, 5.000 mi? (tek üçlü grup) — açık yazım istenir
 *   "1,234.56"      karışık/ters ayırıcı
 *   "1.2.3", "1,2,3", "1e5", "NaN", "Infinity", "0x10"
 */
const INTEGER = /^-?\d+$/;
const COMMA_DECIMAL = /^-?\d+,\d+$/;
const DOT_DECIMAL = /^-?\d+\.\d+$/;
const GROUPED_WITH_DECIMAL = /^-?\d{1,3}(?:\.\d{3})+,\d+$/;
const GROUPED_INTEGER = /^-?\d{1,3}(?:\.\d{3}){2,}$/;
const AMBIGUOUS_SINGLE_GROUP = /^-?[1-9]\d{0,2}\.\d{3}$/;

export const INVALID_NUMBER_MESSAGE = "Geçerli bir sayı girin.";

export function dec(value: string | number | Dec): Dec {
  return new AccountingDecimal(value);
}

export const ZERO = dec(0);

export interface ParseDecimalOptions {
  /** İzin verilen en fazla ondalık basamak. */
  maxScale: number;
  /** false ise sıfır reddedilir. */
  allowZero?: boolean;
  /** true ise negatif reddedilir (varsayılan). */
  nonNegative?: boolean;
}

export type ParseResult = { ok: true; value: Dec } | { ok: false; error: string };

/** Kullanıcı metnini kanonik "1234.56" biçimine çevirir; kabul edilmeyen yazım için hata. */
export function normalizeDecimalText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: false, error: INVALID_NUMBER_MESSAGE };
  if (/\s/.test(text)) {
    return { ok: false, error: "Sayının içinde boşluk olamaz." };
  }
  if (INTEGER.test(text)) return { ok: true, text };
  if (GROUPED_WITH_DECIMAL.test(text)) return { ok: true, text: text.replace(/\./g, "").replace(",", ".") };
  if (COMMA_DECIMAL.test(text)) return { ok: true, text: text.replace(",", ".") };
  if (GROUPED_INTEGER.test(text)) return { ok: true, text: text.replace(/\./g, "") };
  if (AMBIGUOUS_SINGLE_GROUP.test(text)) {
    return {
      ok: false,
      error: `"${text}" belirsiz bir yazım: ondalık için virgül (${text.replace(".", ",")}), binlik için ${text},00 ya da yalnızca rakam (${text.replace(".", "")}) kullanın.`,
    };
  }
  if (DOT_DECIMAL.test(text)) return { ok: true, text };
  return { ok: false, error: INVALID_NUMBER_MESSAGE };
}

/**
 * Kullanıcı / API girdisini sıkı biçimde ondalık sayıya çevirir.
 *
 * Kabul ve ret kuralları dosyanın başındaki tabloda; ayrıca NaN, Infinity, aşırı
 * büyük değer ve izin verilenden fazla ondalık reddedilir.
 */
export function parseDecimalInput(raw: unknown, options: ParseDecimalOptions): ParseResult {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: INVALID_NUMBER_MESSAGE };
    // number yalnızca eski istemciler için tolere edilir; kesinlik için dize beklenir.
    text = String(raw);
    if (/e/i.test(text)) return { ok: false, error: "Sayı çok büyük veya çok küçük." };
  } else if (typeof raw === "string") {
    const normalized = normalizeDecimalText(raw);
    if (!normalized.ok) return normalized;
    text = normalized.text;
  } else {
    return { ok: false, error: INVALID_NUMBER_MESSAGE };
  }

  if (!DECIMAL_LITERAL.test(text)) return { ok: false, error: INVALID_NUMBER_MESSAGE };

  const value = dec(text);
  if (!value.isFinite()) return { ok: false, error: INVALID_NUMBER_MESSAGE };
  if ((options.nonNegative ?? true) && value.isNegative()) {
    return { ok: false, error: "Değer negatif olamaz." };
  }
  if (!options.allowZero && value.isZero()) {
    return { ok: false, error: "Değer sıfırdan büyük olmalıdır." };
  }
  if (value.decimalPlaces() > options.maxScale) {
    return {
      ok: false,
      error:
        options.maxScale === 0
          ? "Bu alanda yalnızca tam sayı girilebilir."
          : `En fazla ${options.maxScale} ondalık basamak girilebilir.`,
    };
  }
  if (value.abs().truncated().toFixed(0).length > MAX_INTEGER_DIGITS) {
    return { ok: false, error: "Değer beklenenden çok büyük. Lütfen kontrol edin." };
  }
  return { ok: true, value };
}

/** Deftere yazılan para değeri: 8 ondalığa HALF_UP. */
export function roundMoney(value: Dec): Dec {
  return value.toDecimalPlaces(MONEY_SCALE, AccountingDecimal.ROUND_HALF_UP);
}

/** API'ye çıkan kanonik dize: bilimsel gösterim yok, gereksiz sondaki sıfırlar yok. */
export function toDecimalString(value: Dec): string {
  const text = value.toFixed();
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

/** Form alanına yazılacak Türkçe biçim: ondalık ayırıcı virgül, binlik ayırıcı YOK ("5.125" → "5,125"). */
export function toInputDecimal(value: string | Dec): string {
  const text = toDecimalString(typeof value === "string" ? dec(value) : value);
  return text.replace(".", ",");
}

/** Karşılaştırma için: dize ondalıkların eşitliği. */
export function decimalEquals(a: string | Dec, b: string | Dec): boolean {
  return dec(a).equals(dec(b));
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_LITERAL.test(value);
}
