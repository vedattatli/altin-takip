import { numberFromEnv } from "@/lib/env";
import { SNAPSHOT_FUTURE_TOLERANCE_MS } from "./types";
import type { MarketId, NormalizedQuote, ProviderId } from "./contract";

/**
 * FİYAT KALİTESİ VE DEVRE KESİCİ
 *
 * Ingestion sırasında her quote buradan geçer. Şüpheli quote:
 *   - güncel değerlemeye GİRMEZ,
 *   - QUARANTINED olarak kaydedilir,
 *   - admin ekranında güvenli hata koduyla görünür.
 *
 * Referans sağlayıcı (BIST vb.) yalnızca sapma kontrolüne yardım eder; birincil
 * yerel fiyatın yerine SESSİZCE geçmez.
 */

export type QuoteRejectionCode =
  | "PRODUCT_UNKNOWN"
  | "PRODUCT_MISMATCH"
  | "PROVIDER_MISMATCH"
  | "MARKET_MISMATCH"
  | "PRICE_NOT_POSITIVE"
  | "INVERTED_SPREAD"
  | "SPREAD_TOO_WIDE"
  | "CURRENCY_NOT_TRY"
  | "TIMESTAMP_INVALID"
  | "TIMESTAMP_PROVENANCE_UNKNOWN"
  | "TIMESTAMP_FUTURE"
  | "STALE"
  | "FETCHED_BEFORE_PROVIDER"
  | "PRICE_JUMP"
  | "OUT_OF_RANGE"
  | "STATUS_NOT_OK"
  | "OBSERVATION_STALE"
  | "OBSERVATION_INVALID";

export type QuoteVerdict =
  | { ok: true; quote: NormalizedQuote }
  | { ok: false; code: QuoteRejectionCode; message: string; quarantine: boolean };

export interface QualityPolicy {
  /** Önceki fiyata göre izin verilen en büyük oransal değişim (0.15 = %15). */
  maxChangeRatio: number;
  /** Makasın bozdurma fiyatına oranı bu değeri aşarsa şüpheli sayılır. */
  maxSpreadRatio: number;
  /** Sağlayıcı zamanı için gelecek toleransı. */
  futureToleranceMs: number;
  /** Ürün için kabul edilen mutlak fiyat aralığı (TL). */
  productRange: { min: number; max: number };
}

/**
 * Eşikler `numberFromEnv` ile okunur: boş bir değişken (`PRICE_MAX_TRY=`)
 * varsayılanı ATLAYIP 0 üretirdi ve kalite kapısı bütün fiyatları reddederdi.
 * Sınırlar da doğrulanır; anlamsız bir değer sessizce kabul edilmez.
 */
export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  maxChangeRatio: numberFromEnv("PRICE_MAX_CHANGE_RATIO", 0.15, { min: 0.000001, max: 10 }),
  maxSpreadRatio: numberFromEnv("PRICE_MAX_SPREAD_RATIO", 0.25, { min: 0.000001, max: 10 }),
  futureToleranceMs: SNAPSHOT_FUTURE_TOLERANCE_MS,
  productRange: {
    min: numberFromEnv("PRICE_MIN_TRY", 1, { min: 0.000001 }),
    max: numberFromEnv("PRICE_MAX_TRY", 100_000_000, { min: 1 }),
  },
};

export interface QualityContext {
  providerId: ProviderId;
  marketId: MarketId;
  /** Katalogdaki geçerli ürün kimlikleri. */
  knownProductIds: ReadonlySet<string>;
  /** Aynı sağlayıcı/ürün için bilinen son geçerli bozdurma fiyatı (sayısal). */
  previousLiquidation?: (productId: string) => number | null;
  now: number;
  policy?: Partial<QualityPolicy>;
  /**
   * GÖZLEM ZAMANI POLİTİKASI (yalnızca deneysel ekran kaynağı)
   *
   * Genel kural değişmez: sağlayıcı fiyat zamanı bildirmiyorsa quote reddedilir.
   * Ancak ekran gözleminde kaynak, ayrı bir fiyat zaman damgası YAYIMLAMIYOR;
   * elimizde yalnızca kendi gözlem anımız var. Bu durum uydurulmaz, açıkça
   * `OBSERVED` olarak taşınır ve BURADA ayrı kurallarla değerlendirilir:
   *   - gözlem geçerli bir zaman olmalı,
   *   - gözlem `maxObservationAgeMs`'ten eski olmamalı,
   *   - gelecek toleransını aşmamalı.
   * Politika yalnızca `providerId` eşleşen kaynak için açılır; başka hiçbir
   * sağlayıcı bu yolla zaman damgası kuralını atlayamaz.
   */
  observedTimePolicy?: {
    providerId: ProviderId;
    maxObservationAgeMs: number;
  };
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseInstant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function reject(code: QuoteRejectionCode, message: string, quarantine = true): QuoteVerdict {
  return { ok: false, code, message, quarantine };
}

/** Tek bir quote'u merkezi kurallara göre denetler. */
export function evaluateQuote(quote: NormalizedQuote, context: QualityContext): QuoteVerdict {
  const policy: QualityPolicy = { ...DEFAULT_QUALITY_POLICY, ...context.policy };

  if (!context.knownProductIds.has(quote.canonicalProductId)) {
    return reject("PRODUCT_UNKNOWN", "Katalogda bulunmayan ürün kimliği.");
  }
  if (quote.providerId !== context.providerId) {
    return reject("PROVIDER_MISMATCH", "Fiyat başka bir sağlayıcıya ait.");
  }
  if (quote.marketId !== context.marketId) {
    return reject("MARKET_MISMATCH", "Fiyat başka bir piyasaya ait; piyasalar karıştırılmaz.");
  }
  if (quote.currency !== "TRY") {
    return reject("CURRENCY_NOT_TRY", "Fiyat TL cinsinden değil.");
  }
  if (quote.status !== "ok") {
    return reject("STATUS_NOT_OK", "Sağlayıcı bu fiyatı geçerli olarak işaretlemedi.");
  }

  const liquidation = toNumber(quote.liquidationPrice);
  const replacement = toNumber(quote.replacementPrice);
  if (!Number.isFinite(liquidation) || !Number.isFinite(replacement) || liquidation <= 0 || replacement <= 0) {
    return reject("PRICE_NOT_POSITIVE", "Fiyat sıfır veya geçersiz.");
  }
  if (replacement < liquidation) {
    return reject("INVERTED_SPREAD", "Yeniden alım fiyatı bozdurma fiyatından düşük (ters makas).");
  }
  if ((replacement - liquidation) / liquidation > policy.maxSpreadRatio) {
    return reject("SPREAD_TOO_WIDE", "Alış-satış makası beklenenden çok geniş.");
  }
  if (liquidation < policy.productRange.min || replacement > policy.productRange.max) {
    return reject("OUT_OF_RANGE", "Fiyat tanımlı aralığın dışında.");
  }

  // GÖZLEM ZAMANI YOLU: yalnızca politika açık olan sağlayıcı için.
  const observed = context.observedTimePolicy;
  if (observed && observed.providerId === quote.providerId && quote.timestampProvenance === "OBSERVED") {
    const observedAt = parseInstant(quote.fetchedAt);
    if (observedAt === null) {
      return reject("OBSERVATION_INVALID", "Gözlem zamanı geçersiz.");
    }
    if (observedAt > context.now + policy.futureToleranceMs) {
      return reject("TIMESTAMP_FUTURE", "Gözlem zamanı gelecekte.");
    }
    if (context.now - observedAt > observed.maxObservationAgeMs) {
      return reject("OBSERVATION_STALE", "Ekran gözlemi çok eski; güncel fiyat sayılmaz.");
    }
    const previousObserved = context.previousLiquidation?.(quote.canonicalProductId) ?? null;
    if (previousObserved !== null && previousObserved > 0) {
      const change = Math.abs(liquidation - previousObserved) / previousObserved;
      if (change > policy.maxChangeRatio) {
        return reject(
          "PRICE_JUMP",
          `Fiyat önceki değere göre beklenenden çok değişti (%${(change * 100).toFixed(1)}).`,
        );
      }
    }
    return { ok: true, quote };
  }

  // Zaman damgasının KAYNAĞI bilinmiyorsa fiyat değerlemeye giremez. Eksik zamanı
  // gözlem zamanıyla doldurmak, bayat veriyi "az önce üretilmiş" gösterirdi.
  if (quote.timestampProvenance === "UNKNOWN" || quote.providerTimestamp === null) {
    return reject(
      "TIMESTAMP_PROVENANCE_UNKNOWN",
      "Sağlayıcı fiyat zamanı bildirmedi; gözlem zamanı fiyat zamanı sayılmaz.",
    );
  }
  const providerTs = parseInstant(quote.providerTimestamp);
  const fetchedAt = parseInstant(quote.fetchedAt);
  if (providerTs === null || fetchedAt === null) {
    return reject("TIMESTAMP_INVALID", "Fiyat zamanı geçersiz.");
  }
  const futureLimit = context.now + policy.futureToleranceMs;
  if (providerTs > futureLimit || fetchedAt > futureLimit) {
    return reject("TIMESTAMP_FUTURE", "Fiyat zamanı gelecekte.");
  }
  if (context.now - providerTs > quote.staleAfterMs || context.now - fetchedAt > quote.staleAfterMs) {
    return reject("STALE", "Fiyat verisi bayat.");
  }
  if (fetchedAt < providerTs - policy.futureToleranceMs) {
    return reject("FETCHED_BEFORE_PROVIDER", "Fiyat, sağlayıcı zamanından önce çekilmiş görünüyor.");
  }

  const previous = context.previousLiquidation?.(quote.canonicalProductId) ?? null;
  if (previous !== null && previous > 0) {
    const change = Math.abs(liquidation - previous) / previous;
    if (change > policy.maxChangeRatio) {
      return reject(
        "PRICE_JUMP",
        `Fiyat önceki değere göre beklenenden çok değişti (%${(change * 100).toFixed(1)}).`,
      );
    }
  }

  return { ok: true, quote };
}

export interface QualityResult {
  accepted: NormalizedQuote[];
  quarantined: { quote: NormalizedQuote; code: QuoteRejectionCode; message: string }[];
}

/** Bir sağlayıcı snapshot'ının tamamını denetler. */
export function evaluateSnapshot(
  quotes: readonly NormalizedQuote[],
  context: QualityContext,
): QualityResult {
  const accepted: NormalizedQuote[] = [];
  const quarantined: QualityResult["quarantined"] = [];
  for (const quote of quotes) {
    const verdict = evaluateQuote(quote, context);
    if (verdict.ok) accepted.push(verdict.quote);
    else quarantined.push({ quote, code: verdict.code, message: verdict.message });
  }
  return { accepted, quarantined };
}

/**
 * Referans sağlayıcıyla sapma kontrolü.
 * Yalnızca UYARI üretir; birincil fiyatın yerine geçmez ve değerlemeyi değiştirmez.
 */
export function compareWithReference(
  primary: readonly NormalizedQuote[],
  reference: readonly NormalizedQuote[],
  toleranceRatio = 0.1,
): { productId: string; primary: string; reference: string; deviationRatio: number }[] {
  const referenceById = new Map(reference.map((quote) => [quote.canonicalProductId, quote]));
  const deviations: { productId: string; primary: string; reference: string; deviationRatio: number }[] = [];
  for (const quote of primary) {
    const other = referenceById.get(quote.canonicalProductId);
    if (!other) continue;
    const a = toNumber(quote.liquidationPrice);
    const b = toNumber(other.liquidationPrice);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) continue;
    const ratio = Math.abs(a - b) / b;
    if (ratio > toleranceRatio) {
      deviations.push({
        productId: quote.canonicalProductId,
        primary: quote.liquidationPrice,
        reference: other.liquidationPrice,
        deviationRatio: ratio,
      });
    }
  }
  return deviations;
}
