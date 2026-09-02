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
 *  - Satışta çıkarılan maliyet (removed_cost_basis) ve ortalama maliyet,
 *    yalnızca sonuç deftere yazılırken 8 ondalığa HALF_UP yuvarlanır.
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

/**
 * Kullanıcı / API girdisini sıkı biçimde ondalık sayıya çevirir.
 *
 * Kabul: "12", "12.5", "0.000001". Türkçe virgül biçimi ("12,5") de kabul edilir.
 * Ret: NaN, Infinity, bilimsel gösterim ("1e5"), onaltılık, boşluk, birden çok
 * ayırıcı, aşırı büyük değer, izin verilenden fazla ondalık.
 */
export function parseDecimalInput(raw: unknown, options: ParseDecimalOptions): ParseResult {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: "Geçerli bir sayı girin." };
    // number yalnızca eski istemciler için tolere edilir; kesinlik için dize beklenir.
    text = String(raw);
    if (/e/i.test(text)) return { ok: false, error: "Sayı çok büyük veya çok küçük." };
  } else if (typeof raw === "string") {
    text = raw.trim().replace(/\s+/g, "");
    // Binlik ayırıcı nokta + ondalık virgül biçimi (1.234,56) ile düz virgül biçimi (12,5).
    if (text.includes(",")) {
      const parts = text.split(",");
      if (parts.length > 2) return { ok: false, error: "Geçerli bir sayı girin." };
      const integer = parts[0]!.replace(/\.(?=\d{3}(?:\.|$))/g, "");
      text = `${integer}.${parts[1]}`;
    }
  } else {
    return { ok: false, error: "Geçerli bir sayı girin." };
  }

  if (!DECIMAL_LITERAL.test(text)) return { ok: false, error: "Geçerli bir sayı girin." };

  const value = dec(text);
  if (!value.isFinite()) return { ok: false, error: "Geçerli bir sayı girin." };
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

/** Karşılaştırma için: dize ondalıkların eşitliği. */
export function decimalEquals(a: string | Dec, b: string | Dec): boolean {
  return dec(a).equals(dec(b));
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_LITERAL.test(value);
}
