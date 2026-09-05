import { SNAPSHOT_FUTURE_TOLERANCE_MS, type PriceQuote, type PriceSnapshot } from "./types";

/**
 * MERKEZİ FİYAT DOĞRULAMASI — bir quote yalnızca burada "kullanılabilir" ilan edilir.
 *
 * Değerleme (engine.valuePositions), MARKET_BASELINE anlık görüntüsü (sunucu servisi ve
 * demo defteri) ve arayüz aynı fonksiyonu kullanır. Gerçek sağlayıcıya geçildiğinde
 * yalnızca sağlayıcı değişir; kabul kuralları değişmez.
 *
 * Kurallar (her biri ayrı bir ret nedeni üretir):
 *  - quote mevcut, istenen ürüne ait ve status = ok
 *  - liquidationPrice > 0, replacementPrice > 0, replacementPrice >= liquidationPrice
 *  - currency = TRY; provider ve market boş değil; snapshot.provider meta ile uyumlu
 *  - providerTimestamp, quote.fetchedAt ve snapshot.fetchedAt geçerli ISO zaman
 *  - hiçbiri toleransı (5 dk) aşacak biçimde gelecekte değil
 *  - hiçbiri sağlayıcının staleAfterMs süresini aşacak kadar eski değil
 *  - fetchedAt, providerTimestamp'tan (toleransın ötesinde) önce değil
 *  - başka ürün veya başka piyasa fiyatı SESSİZCE kullanılmaz
 */

export type QuoteRejectionReason =
  | "snapshot_unavailable"
  | "missing"
  | "product_mismatch"
  | "status"
  | "price"
  | "spread"
  | "currency"
  | "provider"
  | "market"
  | "provider_mismatch"
  | "market_mismatch"
  | "timestamp_invalid"
  | "future"
  | "stale"
  | "fetched_before_provider";

export type QuoteValidation =
  | {
      ok: true;
      quote: PriceQuote;
      /** Kaynağın kendi tazelik eşiği aşıldı mı? Aşıldıysa yaş EKRANDA yazılır. */
      stale: boolean;
      /** Fiyatın ait olduğu an (sağlayıcının kendi damgası). */
      asOf: string;
      /** Fiyatın yaşı (ms). */
      ageMs: number;
    }
  | { ok: false; reason: QuoteRejectionReason; message: string };

const QUOTE_REJECTION_MESSAGES: Record<QuoteRejectionReason, string> = {
  snapshot_unavailable: "Fiyat kaynağına ulaşılamıyor.",
  missing: "Bu ürün için fiyat yok.",
  product_mismatch: "Fiyat başka bir ürüne ait; sessiz ikame yapılmaz.",
  status: "Fiyat verisi kullanılamıyor.",
  price: "Fiyat geçersiz (sıfır veya negatif).",
  spread: "Fiyat makası tutarsız: yeniden alım fiyatı bozdurma fiyatından düşük.",
  currency: "Fiyat para birimi TL değil.",
  provider: "Fiyat sağlayıcısı belirsiz.",
  market: "Fiyat piyasası belirsiz.",
  provider_mismatch: "Fiyat sağlayıcısı anlık görüntünün sağlayıcısıyla uyuşmuyor.",
  market_mismatch: "Fiyat piyasası anlık görüntünün piyasasıyla uyuşmuyor; başka piyasa kullanılmaz.",
  timestamp_invalid: "Fiyat zamanı geçersiz.",
  future: "Fiyat zamanı gelecekte; veri reddedildi.",
  stale: "Fiyat verisi bayat.",
  fetched_before_provider: "Fiyat, sağlayıcı zamanından önce çekilmiş görünüyor; veri tutarsız.",
};

const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Ondalık dizeleri Number'a çevirmeden karşılaştırır (basamak bazlı). */
function comparePositiveDecimals(a: string, b: string): number {
  const [ai, af = ""] = a.split(".") as [string, string?];
  const [bi, bf = ""] = b.split(".") as [string, string?];
  const aInt = ai.replace(/^0+(?=\d)/, "");
  const bInt = bi.replace(/^0+(?=\d)/, "");
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const aFrac = af.padEnd(width, "0");
  const bFrac = bf.padEnd(width, "0");
  if (aFrac === bFrac) return 0;
  return aFrac < bFrac ? -1 : 1;
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

function reject(reason: QuoteRejectionReason): QuoteValidation {
  return { ok: false, reason, message: QUOTE_REJECTION_MESSAGES[reason] };
}

/**
 * PİYASA KAPALIYKEN SON BİLİNEN FİYAT GEÇERLİDİR.
 *
 * Kapalıçarşı gibi kaynaklar yalnızca piyasa açıkken yeni fiyat yayımlar.
 * Cumartesi öğleden sonra kaynağın damgası donar; katı tazelik kuralı bunu
 * "fiyat yok" sayar ve kataloğun yarısı her akşam ve bütün hafta sonu boşalır.
 * Oysa piyasa kapalıyken son işlem fiyatı ZATEN geçerli fiyattır.
 *
 * Bu yüzden tazelik iki kademelidir:
 *   - eşiğin içinde        → taze (stale = false)
 *   - eşik ile bu sınır arası → SON BİLİNEN fiyat (stale = true), yaşı
 *                              kullanıcıya her yerde yazılır
 *   - bu sınırın ötesi     → fiyat sayılmaz; kaynak gerçekten susmuştur
 *
 * Dört gün, uzun bir hafta sonunu (Cuma kapanış → Pazartesi açılış) ve araya
 * giren bir tatil gününü kapsar. Daha uzunu, bozulmuş bir kaynağı çalışıyor
 * gibi gösterirdi.
 */
export const LAST_KNOWN_MAX_AGE_MS = 4 * 24 * 60 * 60_000;

export interface QuoteValidationOptions {
  /**
   * Kaynağın tazelik eşiğini aşmış fiyat da kabul edilsin mi?
   *
   * GÖSTERİM ve DEĞERLEME için true (son bilinen fiyat geçerlidir).
   * KALICI KAYIT yazan yollarda (MARKET_BASELINE açılış bakiyesi) false:
   * deftere yazılan bir maliyet, piyasanın kapalı olduğu bir anın fiyatıyla
   * sabitlenmemelidir.
   */
  allowStale?: boolean;
}

export function validateUsableQuote(
  snapshot: PriceSnapshot | null | undefined,
  quote: PriceQuote | null | undefined,
  productId: string,
  now: number,
  options: QuoteValidationOptions = {},
): QuoteValidation {
  if (!snapshot || snapshot.status === "unavailable") return reject("snapshot_unavailable");
  if (!quote) return reject("missing");
  if (quote.productId !== productId) return reject("product_mismatch");
  if (quote.status !== "ok") return reject("status");
  if (!isPositiveDecimal(quote.liquidationPrice) || !isPositiveDecimal(quote.replacementPrice)) {
    return reject("price");
  }
  if (comparePositiveDecimals(quote.replacementPrice, quote.liquidationPrice) < 0) return reject("spread");
  if (quote.currency !== "TRY") return reject("currency");
  if (typeof quote.provider !== "string" || quote.provider.trim() === "") return reject("provider");
  if (typeof quote.market !== "string" || quote.market.trim() === "") return reject("market");

  /*
   * HİBRİT PLAN DENETİMİ
   *
   * Plan yoksa (tek sağlayıcılı klasik anlık görüntü) fiyat, anlık görüntünün
   * kendi kimliğiyle eşleşmelidir — eski davranış aynen korunur.
   *
   * Plan varsa ürünün kaynağı ÖNCEDEN beyan edilmiştir: planda adı geçmeyen
   * ürün değerlemeye GİREMEZ ve beyandan farklı sağlayıcıdan gelen fiyat
   * reddedilir. Böylece "Çeyrek'in alışı bir kaynaktan, satışı başkasından"
   * gibi bir karışım oluşamaz.
   */
  const plan = snapshot.provider.memberProviders;
  const member = plan ? plan[productId] : undefined;
  if (plan && !member) return reject("provider_mismatch");
  const expectedProvider = member?.provider ?? snapshot.provider.id;
  const expectedMarket = member?.market ?? snapshot.provider.market;
  if (quote.provider !== expectedProvider) return reject("provider_mismatch");
  if (quote.market !== expectedMarket) return reject("market_mismatch");

  const providerTs = parseInstant(quote.providerTimestamp);
  const quoteFetched = parseInstant(quote.fetchedAt);
  const snapshotFetched = parseInstant(snapshot.fetchedAt);
  if (providerTs === null || quoteFetched === null || snapshotFetched === null) {
    return reject("timestamp_invalid");
  }
  const futureLimit = now + SNAPSHOT_FUTURE_TOLERANCE_MS;
  if (providerTs > futureLimit || quoteFetched > futureLimit || snapshotFetched > futureLimit) {
    return reject("future");
  }
  /*
   * Bayatlık her kaynağın KENDİ eşiğiyle ölçülür. Kayseri ekranı saatte bir
   * toplanır, Kapalıçarşı tablosu dakikalarda bir yenilenir; tek bir ortak
   * eşik ya taze veriyi bayat sayardı ya da bayat veriyi güncel gösterirdi.
   *
   * Anlık görüntünün kendi zamanı (en yeni kayıt) ayrıca en geniş eşikle
   * denetlenir: hiçbir kaynak güncellenmiyorsa görüntü tümüyle bayattır.
   */
  const staleAfter = member?.staleAfterMs ?? snapshot.provider.staleAfterMs;
  // Fiyatın yaşı, iki damganın ESKİSİNE göre ölçülür; taze görünmesin diye
  // yenisi seçilmez.
  const ageMs = Math.max(now - providerTs, now - quoteFetched, now - snapshotFetched);
  const stale = now - providerTs > staleAfter || now - quoteFetched > staleAfter || now - snapshotFetched > snapshot.provider.staleAfterMs;
  if (stale) {
    if (options.allowStale !== true) return reject("stale");
    // Son bilinen fiyatın da bir sınırı vardır: bunun ötesi kaynak arızasıdır.
    if (ageMs > LAST_KNOWN_MAX_AGE_MS) return reject("stale");
  }
  if (quoteFetched < providerTs - SNAPSHOT_FUTURE_TOLERANCE_MS) return reject("fetched_before_provider");
  return { ok: true, quote, stale, asOf: quote.providerTimestamp, ageMs };
}

/** Kısa yol: TAZE quote ya da null. Kalıcı kayıt yazan yollar bunu kullanır. */
export function usableQuoteOrNull(
  snapshot: PriceSnapshot | null | undefined,
  productId: string,
  now: number,
): PriceQuote | null {
  const result = validateUsableQuote(snapshot, snapshot?.quotes[productId], productId, now);
  return result.ok ? result.quote : null;
}

export interface LastKnownQuote {
  quote: PriceQuote;
  /** true ise fiyat bayattır ve yaşı kullanıcıya YAZILMALIDIR. */
  stale: boolean;
  asOf: string;
  ageMs: number;
}

/**
 * Gösterim ve değerleme için SON BİLİNEN fiyat.
 *
 * Taze fiyat varsa onu, yoksa `LAST_KNOWN_MAX_AGE_MS` içindeki son fiyatı
 * döner. Bayat dönen her fiyatın yaşı arayüzde gösterilmek ZORUNDADIR;
 * "güncel" denmez.
 */
export function lastKnownQuote(
  snapshot: PriceSnapshot | null | undefined,
  productId: string,
  now: number,
): LastKnownQuote | null {
  const result = validateUsableQuote(snapshot, snapshot?.quotes[productId], productId, now, {
    allowStale: true,
  });
  return result.ok ? { quote: result.quote, stale: result.stale, asOf: result.asOf, ageMs: result.ageMs } : null;
}
