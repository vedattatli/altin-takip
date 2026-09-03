import type { PriceQuote, PriceSnapshot } from "./types";

/**
 * ÇOKLU FİYAT KAYNAĞI SÖZLEŞMESİ (Sprint 3)
 *
 * Her sağlayıcı bu sözleşmeyi uygular. Amaç: farklı piyasaların (Kayseri yerel,
 * genel Türkiye, çoklu kaynak) verisini KARIŞTIRMADAN, lisans durumu açıkça
 * bilinen ve kullanıcıya dürüstçe etiketlenen tek bir kanonik biçime çevirmek.
 *
 * KURALLAR
 * 1. Hiçbir sağlayıcı HTML scrape etmez. Yalnızca resmî/yetkili API veya XML
 *    sözleşmesi kullanılır. Sözleşme bilinmiyorsa adapter NOT_CONFIGURED kalır
 *    ve hayali endpoint YAZILMAZ.
 * 2. API anahtarı yalnızca sunucudadır; istemci paketine girmez.
 * 3. Yeniden gösterim (redistribution) izni açıkça işaretlenmemişse sağlayıcı
 *    üretimde aktive edilemez (fail closed).
 * 4. Bir sağlayıcı başarısız olduğunda BAŞKA sağlayıcıya sessizce geçilmez.
 * 5. Sağlayıcının kendi içinde birden çok upstream kaynağı varsa bu durum
 *    `upstreamSourceId` / "Çoklu Kaynak" etiketiyle görünür kalır.
 */

export type ProviderId =
  | "mock"
  | "sarraf-pro-kayseri"
  | "altinapi"
  | "hasfiyat"
  | "altinkaynak-direct"
  | "harem-direct"
  | "bist-reference"
  /**
   * Sarraf TV Kayseri EKRAN GÖZLEMİ.
   *
   * `sarraf-pro-kayseri` ile AYNI KİMLİK ALTINDA TUTULMAZ: biri ileride
   * gelebilecek yetkili API sözleşmesi, diğeri tarayıcı ekran gözlemidir.
   * Aynı kimliği paylaşsalardı, gözlem verisi lisanslı veri gibi görünürdü.
   */
  | "sarraf-tv-kayseri-screen";

/**
 * SCREEN: değer tarayıcı ekranından okunur; bir REST sözleşmesi DEĞİLDİR.
 * Bu ayrım kasıtlıdır — ekran gözlemini "REST" saymak kaynağın niteliğini gizler.
 */
export type ProviderType = "MOCK" | "REST" | "WEBSOCKET" | "XML" | "REFERENCE" | "SCREEN";

/**
 * Lisans / yapılandırma durumu.
 *   DEV_ONLY          : yalnızca geliştirme ve testte kullanılır (mock)
 *   NOT_CONFIGURED    : kimlik bilgisi veya API sözleşmesi yok
 *   LICENSE_REQUIRED  : teknik olarak hazır; yazılı lisans/izin bekleniyor
 *   LICENSED          : lisans referansı ve yeniden gösterim izni var
 *   EXPERIMENTAL_PRIVATE : deneysel ekran gözlemi. Lisanslı SAYILMAZ, genel
 *                          üretimde açılamaz, yalnızca yönetici izin listesindeki
 *                          portföylerde ve özel pilot ortamında çalışır.
 */
export type LicenseStatus =
  | "DEV_ONLY"
  | "NOT_CONFIGURED"
  | "LICENSE_REQUIRED"
  | "LICENSED"
  | "EXPERIMENTAL_PRIVATE";

export type ProviderCapability =
  | "REST"
  | "WEBSOCKET"
  | "XML"
  | "HISTORICAL"
  | "PRODUCT_LEVEL"
  | "LOCAL_MARKET"
  | "MULTI_SOURCE"
  | "REDISTRIBUTION_LICENSED"
  | "REFERENCE_ONLY"
  /** Deneysel ekran gözlemi; resmî API değildir ve genel üretimde açılamaz. */
  | "EXPERIMENTAL_SCREEN"
  /** Doğrulanmış sağlayıcı sözleşmesi olmadan üretimde kullanılamayan taslak adapter. */
  | "PROTOTYPE";

/**
 * Zaman damgasının kaynağı.
 *  - UPSTREAM: sağlayıcı fiyatın kendi zamanını bildirdi.
 *  - OBSERVED: zaman sağlayıcıdan gelmedi; yalnızca bizim gözlem anımız bilinir.
 *  - UNKNOWN: geçerli bir zaman elde edilemedi (kalite kapısından geçemez).
 */
export type TimestampProvenance = "UPSTREAM" | "OBSERVED" | "UNKNOWN";

/** Kanonik piyasa kimlikleri. Farklı piyasaların fiyatı birbirinin yerine KULLANILMAZ. */
export type MarketId = "test" | "kayseri" | "turkiye-genel" | "composite" | "bist";

export const MARKET_DISPLAY_NAMES: Record<MarketId, string> = {
  test: "Test Piyasası",
  kayseri: "Kayseri Yerel Piyasa",
  "turkiye-genel": "Genel Türkiye",
  composite: "Çoklu Kaynak",
  bist: "BIST Referans",
};

/** Bir sağlayıcıdan gelen tek fiyat kaydının kanonik biçimi. */
export interface NormalizedQuote {
  canonicalProductId: string;
  providerId: ProviderId;
  /**
   * Sağlayıcının kendi içindeki üst kaynak (örn. çoklu kaynak birleştiren bir
   * servis). Bilinmiyorsa null; UI bu durumda "Çoklu Kaynak" etiketi gösterir.
   */
  upstreamSourceId: string | null;
  marketId: MarketId;
  /** Kuyumcunun kullanıcıdan aldığı fiyat (bozdurma). Ondalık dize. */
  liquidationPrice: string;
  /** Kuyumcunun kullanıcıya sattığı fiyat (yeniden alım). Ondalık dize. */
  replacementPrice: string;
  currency: "TRY";
  /**
   * Sağlayıcının bildirdiği fiyat zamanı.
   *
   * Sağlayıcı zaman vermiyorsa BURAYA GÖZLEM ZAMANI YAZILMAZ; alan null kalır ve
   * `timestampProvenance` "UNKNOWN" olur. Aksi hâlde bayat bir fiyat, çekildiği
   * anda üretilmiş gibi görünür ve tazelik kontrolü anlamsızlaşırdı.
   */
  providerTimestamp: string | null;
  /** Zaman damgasının kaynağı. UNKNOWN olan quote değerlemeye giremez. */
  timestampProvenance: TimestampProvenance;
  /** Bizim gözlem zamanımız — yalnızca gözlemdir, fiyat zamanı DEĞİLDİR. */
  fetchedAt: string;
  status: "ok" | "stale" | "unavailable";
  staleAfterMs: number;
  /** Ham yanıtın özeti (denetim izi). Ham yanıtın kendisi saklanmaz. */
  rawPayloadHash: string | null;
  mappingVersion: string;
  licenseReference: string | null;
  ingestionRunId: string | null;
}

/** Sağlayıcının tek çekimde döndürdüğü sonuç. */
export interface ProviderSnapshot {
  providerId: ProviderId;
  marketId: MarketId;
  quotes: NormalizedQuote[];
  fetchedAt: string;
  /** ok = istenen tüm ürünler geldi, partial = bir kısmı, unavailable = hiçbiri. */
  status: "ok" | "partial" | "unavailable";
  /** Kullanıcıya gösterilebilir Türkçe hata. Secret veya ham payload İÇERMEZ. */
  error: string | null;
  /** Güvenli hata kodu (log ve admin ekranı için). */
  safeErrorCode: string | null;
  latencyMs: number;
}

export interface ProviderHealth {
  providerId: ProviderId;
  status: "ok" | "degraded" | "unavailable" | "not_configured" | "license_required";
  checkedAt: string;
  latencyMs: number | null;
  message: string;
  safeErrorCode: string | null;
}

export interface ProviderConfigIssue {
  /** Eksik/yanlış ortam değişkeni ADI. Değer ASLA yazılmaz. */
  variable: string;
  message: string;
}

export interface ProviderConfigValidation {
  ok: boolean;
  licenseStatus: LicenseStatus;
  issues: ProviderConfigIssue[];
}

export interface ProviderCapabilities {
  capabilities: readonly ProviderCapability[];
  /** Değerlemede birincil kaynak olabilir mi? REFERENCE_ONLY sağlayıcılarda false. */
  canBePrimary: boolean;
  supportsWebSocket: boolean;
  /** Kalıcı worker gerektirir mi? (Vercel istek ömrü içinde sonsuz bağlantı açılmaz.) */
  requiresPersistentWorker: boolean;
}

/** Sağlayıcı kataloğundaki değişmez tanım (veritabanı tohumunun kaynağı). */
export interface ProviderDescriptor {
  providerId: ProviderId;
  /** Kullanıcıya gösterilen ad — piyasa odaklı. */
  displayName: string;
  /** Teknik sağlayıcı etiketi (detay/tooltip). */
  technicalName: string;
  marketId: MarketId;
  marketDisplayName: string;
  providerType: ProviderType;
  capabilities: readonly ProviderCapability[];
  /** Kaynağın resmî sayfası (yalnızca referans bağlantısı; scrape edilmez). */
  referenceUrl: string | null;
  /** Kullanıcıya gösterilecek kısa açıklama / kaynak beyanı. */
  attribution: string;
  /** Zorunlu ortam değişkeni ADLARI (değerler değil). */
  requiredEnv: readonly string[];
  /** Bu sağlayıcı yalnızca geliştirme ortamında mı çalışır? */
  devOnly: boolean;
  /**
   * Sağlayıcının SUNDUĞUNU söylediği ama bizde ÇALIŞAN adapter'ı bulunmayan
   * yetenekler. Yönetim ekranında "çalışan özellik" gibi gösterilmez.
   */
  advertisedCapabilities?: readonly ProviderCapability[];
}

/** Tüm sağlayıcıların uyduğu çalışma zamanı sözleşmesi. */
export interface CanonicalPriceProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly technicalName: string;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly providerType: ProviderType;
  readonly descriptor: ProviderDescriptor;

  /** Ortam değişkenlerine göre güncel lisans/yapılandırma durumu. */
  licenseStatus(): LicenseStatus;
  /** Lisans referansı (sözleşme numarası vb.). Yoksa null. */
  licenseReference(): string | null;
  getCapabilities(): ProviderCapabilities;
  /** Yapılandırmayı doğrular; eksik ortam değişkeni ADLARINI döner. */
  validateConfiguration(): ProviderConfigValidation;
  /** Bu sağlayıcının eşleyebildiği kanonik ürün kimlikleri. */
  listSupportedProducts(): readonly string[];
  /** Sağlayıcıya erişim kontrolü. Ağ çağrısı yapmayan sağlayıcılarda statik yanıt. */
  healthCheck(options?: FetchOptions): Promise<ProviderHealth>;
  /** Fiyatları çeker ve kanonik biçime çevirir. Hata durumunda unavailable snapshot döner. */
  fetchSnapshot(productIds: readonly string[], options?: FetchOptions): Promise<ProviderSnapshot>;
  /** Ham sağlayıcı kaydını kanonik biçime çevirir (fixture testleri bunu kullanır). */
  normalizeQuote(raw: unknown, context: NormalizeContext): NormalizedQuote | null;
}

export interface FetchOptions {
  now?: () => number;
  ingestionRunId?: string | null;
  signal?: AbortSignal;
  /** Testlerde ağ katmanını değiştirmek için. */
  fetchImpl?: typeof fetch;
}

export interface NormalizeContext {
  fetchedAt: string;
  ingestionRunId: string | null;
  now: number;
}

/** Kanonik quote → muhasebe motorunun beklediği PriceQuote. */
export function toPriceQuote(quote: NormalizedQuote): PriceQuote {
  if (quote.providerTimestamp === null) {
    // Zamanı bilinmeyen quote buraya ULAŞMAMALIDIR; kalite kapısı onu daha önce
    // reddeder. Yine de sessizce gözlem zamanı yazmak yerine açıkça durulur.
    throw new Error("Sağlayıcı zamanı bilinmeyen fiyat değerlemeye çevrilemez.");
  }
  return {
    productId: quote.canonicalProductId,
    liquidationPrice: quote.liquidationPrice,
    replacementPrice: quote.replacementPrice,
    currency: quote.currency,
    market: quote.marketId,
    provider: quote.providerId,
    providerTimestamp: quote.providerTimestamp,
    fetchedAt: quote.fetchedAt,
    status: quote.status,
  };
}

/**
 * Kanonik snapshot → muhasebe motorunun beklediği PriceSnapshot.
 * `isRealMarketData` yalnızca LICENSED sağlayıcılarda true olur; mock ve
 * yapılandırılmamış sağlayıcılar hiçbir koşulda gerçek piyasa verisi sayılmaz.
 */
export function toPriceSnapshot(
  snapshot: ProviderSnapshot,
  provider: Pick<CanonicalPriceProvider, "displayName" | "technicalName" | "marketDisplayName"> & {
    licenseStatus(): LicenseStatus;
  },
  staleAfterMs: number,
  disclaimer: string,
): PriceSnapshot {
  const licensed = provider.licenseStatus() === "LICENSED";
  return {
    provider: {
      id: snapshot.providerId,
      label: provider.displayName,
      market: snapshot.marketId,
      isRealMarketData: licensed,
      disclaimer,
      staleAfterMs,
    },
    quotes: Object.fromEntries(snapshot.quotes.map((quote) => [quote.canonicalProductId, toPriceQuote(quote)])),
    fetchedAt: snapshot.fetchedAt,
    status: snapshot.status,
    error: snapshot.error,
  };
}
