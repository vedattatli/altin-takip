import { MARKET_DISPLAY_NAMES, type ProviderDescriptor, type ProviderId } from "./contract";

/**
 * SAĞLAYICI KATALOĞU — değişmez tanımlar.
 *
 * Bu dosya "hangi kaynaklar var, hangi piyasayı temsil eder, hangi ortam
 * değişkenleri gerekir" sorusunun tek cevabıdır. Veritabanı `price_providers`
 * tablosu bu tanımlardan tohumlanır.
 *
 * DÜRÜST ETİKETLEME
 * - Hiçbir sağlayıcı, bağlı olmadığı bir kurumun "resmî" servisi gibi anılmaz.
 * - Kullanıcıya önce PİYASA adı gösterilir; teknik sağlayıcı adı detaydadır.
 * - Kaynak sayfaları yalnızca referans bağlantısıdır; içerikleri scrape edilmez.
 */

const SARRAF_PRO: ProviderDescriptor = {
  providerId: "sarraf-pro-kayseri",
  displayName: MARKET_DISPLAY_NAMES.kayseri,
  technicalName: "Sarraf Pro / KAYSARDER",
  marketId: "kayseri",
  marketDisplayName: MARKET_DISPLAY_NAMES.kayseri,
  providerType: "REST",
  capabilities: ["REST", "XML", "PRODUCT_LEVEL", "LOCAL_MARKET"],
  referenceUrl: "https://www.kaysarder.org.tr/",
  attribution:
    "Kayseri Kuyumcular Odası (KAYSARDER) yerel piyasa verisi, Sarraf Pro yetkili veri sözleşmesi üzerinden alınır. " +
    "Sayfa içeriği kopyalanmaz; yalnızca yetkili API/XML sözleşmesi kullanılır.",
  requiredEnv: [
    "SARRAFPRO_API_URL",
    "SARRAFPRO_API_KEY",
    "SARRAFPRO_MARKET_ID",
    "SARRAFPRO_LICENSE_REFERENCE",
    "SARRAFPRO_REDISTRIBUTION_ALLOWED",
  ],
  devOnly: false,
};

const ALTINAPI: ProviderDescriptor = {
  providerId: "altinapi",
  displayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  technicalName: "AltinAPI — bağımsız veri sağlayıcısı",
  marketId: "turkiye-genel",
  marketDisplayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  providerType: "REST",
  capabilities: ["REST", "WEBSOCKET", "PRODUCT_LEVEL", "HISTORICAL"],
  referenceUrl: null,
  attribution:
    "AltinAPI bağımsız bir veri sağlayıcısıdır; Harem Altın'ın veya başka bir kurumun resmî servisi değildir.",
  requiredEnv: [
    "ALTINAPI_API_KEY",
    "ALTINAPI_LICENSE_TIER",
    "ALTINAPI_REDISTRIBUTION_ALLOWED",
  ],
  devOnly: false,
};

const HASFIYAT: ProviderDescriptor = {
  providerId: "hasfiyat",
  displayName: "Hasfiyat Çoklu Kaynak",
  technicalName: "Hasfiyat — çoklu kaynak birleşimi",
  marketId: "composite",
  marketDisplayName: MARKET_DISPLAY_NAMES.composite,
  providerType: "REST",
  capabilities: ["REST", "WEBSOCKET", "PRODUCT_LEVEL", "MULTI_SOURCE"],
  referenceUrl: null,
  attribution:
    "Hasfiyat birden çok üst kaynağı birleştirir. Üst kaynak açıkça bildirilmediğinde veri tek bir kurumun " +
    "fiyatı gibi etiketlenmez; 'Çoklu Kaynak' olarak gösterilir.",
  requiredEnv: [
    "HASFIYAT_API_URL",
    "HASFIYAT_API_KEY",
    "HASFIYAT_LICENSE_REFERENCE",
    "HASFIYAT_REDISTRIBUTION_ALLOWED",
  ],
  devOnly: false,
};

const ALTINKAYNAK_DIRECT: ProviderDescriptor = {
  providerId: "altinkaynak-direct",
  displayName: "Altınkaynak (doğrudan)",
  technicalName: "Altınkaynak — resmî API sözleşmesi bekleniyor",
  marketId: "turkiye-genel",
  marketDisplayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  providerType: "REST",
  capabilities: ["REST", "PRODUCT_LEVEL"],
  referenceUrl: null,
  attribution:
    "Yalnızca sağlayıcı tanımı hazırdır. Resmî API sözleşmesi ve yazılı izin olmadan veri çekilmez; " +
    "site içeriği scrape edilmez.",
  requiredEnv: [],
  devOnly: false,
};

const HAREM_DIRECT: ProviderDescriptor = {
  providerId: "harem-direct",
  displayName: "Harem Altın (doğrudan)",
  technicalName: "Harem Altın — resmî API sözleşmesi bekleniyor",
  marketId: "turkiye-genel",
  marketDisplayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  providerType: "REST",
  capabilities: ["REST", "PRODUCT_LEVEL"],
  referenceUrl: null,
  attribution:
    "Yalnızca sağlayıcı tanımı hazırdır. Resmî API sözleşmesi ve yazılı izin olmadan veri çekilmez; " +
    "site içeriği scrape edilmez.",
  requiredEnv: [],
  devOnly: false,
};

const BIST_REFERENCE: ProviderDescriptor = {
  providerId: "bist-reference",
  displayName: "BIST Referans (yalnızca kontrol)",
  technicalName: "BIST — referans/anomali kontrolü",
  marketId: "bist",
  marketDisplayName: MARKET_DISPLAY_NAMES.bist,
  providerType: "REFERENCE",
  capabilities: ["REST", "HISTORICAL", "REFERENCE_ONLY"],
  referenceUrl: null,
  attribution:
    "Organize piyasa referansıdır. Yerel ziynet (çeyrek, Ata, Reşat) bozdurma hesabında KULLANILMAZ; " +
    "yalnızca veri sapması ve sağlık kontrolü içindir.",
  requiredEnv: [],
  devOnly: false,
};

const MOCK: ProviderDescriptor = {
  providerId: "mock",
  displayName: "Test Verisi",
  technicalName: "MockPriceProvider (geliştirme)",
  marketId: "test",
  marketDisplayName: MARKET_DISPLAY_NAMES.test,
  providerType: "MOCK",
  capabilities: ["REST", "PRODUCT_LEVEL"],
  referenceUrl: null,
  attribution:
    "Test amaçlı üretilmiş örnek veridir. Gerçek piyasa fiyatı değildir; alım satım kararı için kullanılamaz.",
  requiredEnv: [],
  devOnly: true,
};

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  MOCK,
  SARRAF_PRO,
  ALTINAPI,
  HASFIYAT,
  ALTINKAYNAK_DIRECT,
  HAREM_DIRECT,
  BIST_REFERENCE,
];

const BY_ID = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.providerId, descriptor]));

export function getProviderDescriptor(providerId: string): ProviderDescriptor | undefined {
  return BY_ID.get(providerId as ProviderId);
}

export function requireProviderDescriptor(providerId: string): ProviderDescriptor {
  const descriptor = BY_ID.get(providerId as ProviderId);
  if (!descriptor) throw new Error(`Bilinmeyen fiyat sağlayıcısı: ${providerId}`);
  return descriptor;
}
