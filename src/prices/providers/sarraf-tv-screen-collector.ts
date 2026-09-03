import type { MarketId, NormalizedQuote, TimestampProvenance } from "../contract";
import { SARRAF_TV_SCREEN_MAPPING_VERSION, type MappingConfidence } from "./sarraf-tv-screen-mapping";

/**
 * SARRAF TV KAYSERİ EKRAN TOPLAYICISI — DENEYSEL
 *
 * Fizibilite testi (`npm run price:sarraf-feasibility`) başarılı olduğu için
 * eklendi. Ekran değerleri normal bir tarayıcı oturumunda okunabiliyor ve
 * çıkarılan JSON, ekranda görünen metinle birebir doğrulanıyor.
 *
 * NE DEĞİLDİR:
 *  - Resmî API değildir. `SARRAF_PRO_API` veya `OFFICIAL_API` diye anılmaz.
 *  - LICENSED değildir; veri türü `LIVE_SCREEN_EXPERIMENTAL`'dir.
 *  - Üretim sağlayıcı kaydına (registry) OTOMATİK EKLENMEZ.
 *  - Kullanıcının tarayıcısında ÇALIŞMAZ; merkezî tek worker olarak tasarlanır.
 *
 * ÇALIŞMA KOŞULLARI:
 *  - Yalnızca `PRICE_EXPERIMENTAL_SARRAF_SCREEN=true` iken etkinleşir.
 *  - Gerçek üretim dağıtımında (VERCEL_ENV=production) bu bayrak yok sayılır.
 *  - CAPTCHA veya etkileşim gerekirse UNAVAILABLE döner; aşma DENENMEZ.
 *  - Ekran yapısı beklenen imzaya uymazsa fail closed olur; yanlış fiyat
 *    üretmek yerine hiç fiyat üretmez.
 *
 * Bu sprintte üretime veya gerçek kullanıcı portföyüne BAĞLANMAMIŞTIR.
 */

export const SARRAF_TV_DATA_KIND = "LIVE_SCREEN_EXPERIMENTAL" as const;

export const SARRAF_TV_DISCLAIMER =
  "Sarraf TV Kayseri ekranından normal tarayıcı oturumuyla gözlenen deneysel fiyat verisidir. Resmî API değildir.";

/** Toplayıcının çalışma durumu. */
export type CollectorStatus = "DISABLED" | "OK" | "PARTIAL" | "UNAVAILABLE" | "BLOCKED";

export interface CollectorObservation {
  canonicalProductId: string;
  mappingConfidence: MappingConfidence;
  liquidationPrice: string;
  replacementPrice: string;
  /** Ekranda kaynak zaman damgası yoksa yalnızca gözlem anımız bilinir. */
  observedAt: string;
}

export interface CollectorResult {
  status: CollectorStatus;
  dataKind: typeof SARRAF_TV_DATA_KIND;
  quotes: NormalizedQuote[];
  /** Çözülemeyen satırlar; sessizce yutulmaz. */
  unresolved: { rawProductName: string; reason: string }[];
  safeErrorCode: string | null;
  message: string;
}

/** Gerçek üretim dağıtımı mı? (Deneysel toplayıcı burada ASLA çalışmaz.) */
function productionDeployment(): boolean {
  const vercel = (process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercel === "production") return true;
  return (process.env.APP_DEPLOYMENT_ENV ?? "").trim().toLowerCase() === "production";
}

/** Deneysel toplayıcı bu ortamda etkin mi? */
export function screenCollectorEnabled(): boolean {
  if (productionDeployment()) return false;
  return (process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN ?? "").trim().toLowerCase() === "true";
}

/**
 * Ekran imzası doğrulaması.
 *
 * Beklenen imza: "ALIŞ" ve "SATIŞ" başlıkları görünür ve en az bir çift fiyatlı
 * satır bulunur. İmza tutmazsa fail closed: hiç quote üretilmez.
 */
export function screenSignatureValid(headers: readonly string[], rowCount: number): boolean {
  const upper = headers.map((header) => header.trim().toLocaleUpperCase("tr-TR"));
  return upper.includes("ALIŞ") && upper.includes("SATIŞ") && rowCount > 0;
}

export interface CollectorInput {
  headers: readonly string[];
  observations: readonly CollectorObservation[];
  unresolved: readonly { rawProductName: string; reason: string }[];
  captchaSeen: boolean;
  ingestionRunId: string | null;
}

/**
 * Gözlemleri kanonik quote'lara çevirir.
 *
 * Zaman kaynağı `OBSERVED`'dır: ekran kendi fiyat zamanını bildirmiyor, yalnızca
 * gözlem anımızı biliyoruz. Bu ayrım kanonik sözleşmede açıkça taşınır ve
 * "sağlayıcı zamanı" gibi gösterilmez.
 */
export function collectScreenQuotes(input: CollectorInput): CollectorResult {
  if (!screenCollectorEnabled()) {
    return {
      status: "DISABLED",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved: [],
      safeErrorCode: "EXPERIMENTAL_DISABLED",
      message: "Deneysel ekran toplayıcısı kapalı.",
    };
  }
  if (input.captchaSeen) {
    // CAPTCHA aşılmaz; kaynak kullanılamaz sayılır.
    return {
      status: "BLOCKED",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved: [...input.unresolved],
      safeErrorCode: "CAPTCHA_OR_INTERACTION_REQUIRED",
      message: "Ekran doğrulama istedi; aşma denenmedi ve fiyat alınmadı.",
    };
  }
  if (!screenSignatureValid(input.headers, input.observations.length)) {
    return {
      status: "UNAVAILABLE",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved: [...input.unresolved],
      safeErrorCode: "SCREEN_SIGNATURE_MISMATCH",
      message: "Ekran yapısı beklenen imzaya uymadı; yanlış fiyat üretmemek için hiçbir değer alınmadı.",
    };
  }

  const marketId: MarketId = "kayseri";
  const provenance: TimestampProvenance = "OBSERVED";
  const quotes: NormalizedQuote[] = input.observations.map((observation) => ({
    canonicalProductId: observation.canonicalProductId,
    providerId: "sarraf-pro-kayseri",
    upstreamSourceId: "sarraf-tv-screen",
    marketId,
    liquidationPrice: observation.liquidationPrice,
    replacementPrice: observation.replacementPrice,
    currency: "TRY",
    // Ekran kendi fiyat zamanını yayımlamıyor: sağlayıcı zamanı YOKTUR.
    providerTimestamp: null,
    timestampProvenance: provenance,
    fetchedAt: observation.observedAt,
    status: "ok",
    staleAfterMs: 5 * 60_000,
    rawPayloadHash: null,
    mappingVersion: SARRAF_TV_SCREEN_MAPPING_VERSION,
    licenseReference: null,
    ingestionRunId: input.ingestionRunId,
  }));

  return {
    status: input.unresolved.length > 0 ? "PARTIAL" : "OK",
    dataKind: SARRAF_TV_DATA_KIND,
    quotes,
    unresolved: [...input.unresolved],
    safeErrorCode: null,
    message: `${quotes.length} ürün ekrandan gözlendi, ${input.unresolved.length} satır çözülemedi.`,
  };
}
