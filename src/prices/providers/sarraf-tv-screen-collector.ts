import type { MarketId, NormalizedQuote, TimestampProvenance } from "../contract";
import { stringFromEnv } from "@/lib/env";
import {
  isValuationReady,
  SARRAF_TV_SCREEN_MAPPING_VERSION,
  type MappingConfidence,
} from "./sarraf-tv-screen-mapping";

/**
 * SARRAF TV KAYSERİ EKRAN GÖZLEMİ — DENEYSEL, ÖZEL PİLOT
 *
 * Ölçülen gerçek: bayi fiyatları tarayıcıda HESAPLANIYOR. Kaynağın REST yanıtı
 * yalnızca açılışta parametreleri ve başlangıç fiyatını verir; canlı WebSocket
 * akışı yalnızca GENEL PİYASA kurunu taşır. Nihai Kayseri fiyatı sadece ekranda
 * bulunur. Bu yüzden değer kanalı DOM'dur ve toplayıcı kalıcı bir tarayıcı
 * worker'ından beslenir.
 *
 * NE DEĞİLDİR:
 *  - Resmî API değildir. `SARRAF_PRO_API` veya `OFFICIAL_API` diye anılmaz.
 *  - LICENSED değildir; veri türü `LIVE_SCREEN_EXPERIMENTAL`'dir.
 *  - Kullanıcının tarayıcısında çalışmaz.
 *
 * ÇALIŞMA KOŞULLARI:
 *  - `PRICE_EXPERIMENTAL_SARRAF_SCREEN=true` olmadan hiç çalışmaz.
 *  - Gerçek üretim dağıtımında bayrak YOK SAYILIR.
 *  - CAPTCHA/etkileşim gerekirse BLOCKED döner; aşma DENENMEZ.
 *  - Ekran imzası beklenen biçimde değilse fail closed olur.
 *  - Yalnızca değerlemeye HAZIR güven seviyesindeki eşlemeler quote üretir.
 */

export const SARRAF_TV_DATA_KIND = "LIVE_SCREEN_EXPERIMENTAL" as const;

export const SARRAF_TV_DISCLAIMER =
  "Sarraf TV Kayseri ekranından normal tarayıcı oturumuyla gözlenen deneysel fiyat verisidir. Resmî API değildir.";

/** Gözlemin en fazla ne kadar eski olabileceği (deneysel gözlem politikası). */
/**
 * ZAMANLANMIŞ BULUT TOPLAYICISI İÇİN BAYATLIK EŞİKLERİ
 *
 * Fiyat artık sürekli çalışan bir worker'dan değil, saatte bir çalışan
 * ücretsiz bir bulut görevinden gelir. GitHub zamanlanmış koşumları yoğun
 * anlarda gecikebilir; eski 120 saniyelik eşik bu modelde her fiyatı
 * reddederdi.
 *
 * Politika:
 *   0–90 dk    Güncel
 *   90–180 dk  Bayat (kullanıcıya açıkça bayat gösterilir)
 *   >180 dk    Kullanılamıyor (fiyat kabul EDİLMEZ)
 *
 * Bayat fiyat "güncel" gibi gösterilmez ve hiçbir koşulda başka kaynağa
 * veya test verisine düşülmez.
 */
export const SCREEN_OBSERVATION_FRESH_MS = 90 * 60_000;

/** Bu yaşın üstündeki gözlem hiç kabul edilmez. */
export const SCREEN_OBSERVATION_MAX_AGE_MS = 180 * 60_000;

export type CollectorStatus = "DISABLED" | "OK" | "PARTIAL" | "UNAVAILABLE" | "BLOCKED";

export interface CollectorObservation {
  canonicalProductId: string;
  mappingConfidence: MappingConfidence;
  liquidationPrice: string;
  replacementPrice: string;
  /** Ekranın gözlendiği an. Kaynak kendi fiyat zamanını yayımlamıyor. */
  observedAt: string;
}

export interface CollectorResult {
  status: CollectorStatus;
  dataKind: typeof SARRAF_TV_DATA_KIND;
  quotes: NormalizedQuote[];
  /** Çözülemeyen veya onay bekleyen satırlar; sessizce yutulmaz. */
  unresolved: { rawProductName: string; reason: string }[];
  safeErrorCode: string | null;
  message: string;
}

/**
 * Ekran toplayıcısı çalışabilir mi?
 *
 * Eskiden üç ortam bayrağına bağlıydı; biri eksik kalınca kaynak sessizce
 * ölüyor ve kullanıcı sebebini göremiyordu. Artık tek koşul worker sırrının
 * tanımlı olmasıdır — o olmadan imzalı uç zaten çalışamaz.
 */
export function screenCollectorEnabled(): boolean {
  return stringFromEnv("PRICE_SCREEN_WORKER_SECRET", "").trim() !== "";
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
  /** Yönetici tarafından onaylanmış eşlemeler (ürün → güven). */
  approvedMappings?: ReadonlyMap<string, MappingConfidence>;
  now?: () => number;
}

/**
 * Gözlemleri kanonik quote'lara çevirir.
 *
 * Zaman kaynağı `OBSERVED`'dır: ekran kendi fiyat zamanını bildirmiyor, yalnızca
 * gözlem anımızı biliyoruz. Bu ayrım kanonik sözleşmede açıkça taşınır ve
 * "sağlayıcı zamanı" gibi gösterilmez.
 */
export function collectScreenQuotes(input: CollectorInput): CollectorResult {
  const now = input.now?.() ?? Date.now();
  const unresolved = [...input.unresolved];

  if (!screenCollectorEnabled()) {
    return {
      status: "DISABLED",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved: [],
      safeErrorCode: "COLLECTOR_DISABLED",
      message: "Ekran toplayıcısı yapılandırılmadı (worker sırrı yok).",
    };
  }
  if (input.captchaSeen) {
    return {
      status: "BLOCKED",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved,
      safeErrorCode: "CAPTCHA_OR_INTERACTION_REQUIRED",
      message: "Ekran doğrulama istedi; aşma denenmedi ve fiyat alınmadı.",
    };
  }
  if (!screenSignatureValid(input.headers, input.observations.length)) {
    return {
      status: "UNAVAILABLE",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes: [],
      unresolved,
      safeErrorCode: "SCREEN_SIGNATURE_MISMATCH",
      message: "Ekran yapısı beklenen imzaya uymadı; yanlış fiyat üretmemek için hiçbir değer alınmadı.",
    };
  }

  const marketId: MarketId = "kayseri";
  const provenance: TimestampProvenance = "OBSERVED";
  const quotes: NormalizedQuote[] = [];

  for (const observation of input.observations) {
    // Yönetici onayı, CONVENTION eşlemesini OPERATOR_VERIFIED'a yükseltebilir.
    const approved = input.approvedMappings?.get(observation.canonicalProductId);
    const confidence: MappingConfidence = approved ?? observation.mappingConfidence;
    if (!isValuationReady(confidence)) {
      unresolved.push({
        rawProductName: observation.canonicalProductId,
        reason: `ONAY_BEKLIYOR_${confidence}`,
      });
      continue;
    }

    const observedAtMs = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      unresolved.push({ rawProductName: observation.canonicalProductId, reason: "GOZLEM_ZAMANI_GECERSIZ" });
      continue;
    }
    if (now - observedAtMs > SCREEN_OBSERVATION_MAX_AGE_MS) {
      unresolved.push({ rawProductName: observation.canonicalProductId, reason: "GOZLEM_BAYAT" });
      continue;
    }

    quotes.push({
      canonicalProductId: observation.canonicalProductId,
      providerId: "sarraf-tv-kayseri-screen",
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
      // UI 90 dakikadan sonra BAYAT gösterir; kabul sınırı 180 dakikadır.
      staleAfterMs: SCREEN_OBSERVATION_FRESH_MS,
      rawPayloadHash: null,
      mappingVersion: SARRAF_TV_SCREEN_MAPPING_VERSION,
      licenseReference: null,
      ingestionRunId: input.ingestionRunId,
    });
  }

  if (quotes.length === 0) {
    return {
      status: "UNAVAILABLE",
      dataKind: SARRAF_TV_DATA_KIND,
      quotes,
      unresolved,
      safeErrorCode: "NO_VALUATION_READY_QUOTE",
      message: "Değerlemeye hazır (onaylı) eşleme bulunamadı; hiçbir fiyat alınmadı.",
    };
  }

  return {
    status: unresolved.length > 0 ? "PARTIAL" : "OK",
    dataKind: SARRAF_TV_DATA_KIND,
    quotes,
    unresolved,
    safeErrorCode: null,
    message: `${quotes.length} ürün ekrandan gözlendi, ${unresolved.length} satır çözülemedi veya onay bekliyor.`,
  };
}
