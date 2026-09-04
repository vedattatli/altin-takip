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
  technicalName: "Sarraf Pro (Kayseri Sarraflar ve Kuyumcular Derneği ekranı)",
  marketId: "kayseri",
  marketDisplayName: MARKET_DISPLAY_NAMES.kayseri,
  providerType: "REST",
  // ÇALIŞAN yetenekler. XML sözleşmesi için bizde parser YOK; aşağıda yalnızca
  // "sağlayıcı sunduğunu söylüyor" olarak listelenir.
  capabilities: ["REST", "PRODUCT_LEVEL", "LOCAL_MARKET", "PROTOTYPE"],
  advertisedCapabilities: ["XML"],
  referenceUrl: "https://kaysarder.org.tr/altin-fiyatlari",
  // Kurum adı KAYSARDER'ın kendi sitesindeki resmî adıdır. Derneğin verinin
  // sahibi veya resmî API sağlayıcısı olduğu, sözleşme olmadan İDDİA EDİLMEZ.
  attribution:
    "Kayseri Sarraflar ve Kuyumcular Derneği (KAYSARDER) fiyat sayfasında tv.sarraf.pro üzerinden yayımlanan " +
    "Kayseri yerel piyasa ekranı. Üretimde yalnızca yetkili API/XML sözleşmesiyle alınır; sayfa içeriği kopyalanmaz.",
  requiredEnv: [
    "SARRAFPRO_API_URL",
    "SARRAFPRO_API_KEY",
    "SARRAFPRO_MARKET_ID",
    "SARRAFPRO_LICENSE_REFERENCE",
    "SARRAFPRO_REDISTRIBUTION_ALLOWED",
    "SARRAFPRO_CONTRACT_VERSION",
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
  // WebSocket akışı için çalışan adapter yok; REST ile alınır.
  capabilities: ["REST", "PRODUCT_LEVEL", "HISTORICAL", "PROTOTYPE"],
  advertisedCapabilities: ["WEBSOCKET"],
  referenceUrl: null,
  attribution:
    "AltinAPI bağımsız bir veri sağlayıcısıdır; Harem Altın'ın veya başka bir kurumun resmî servisi değildir.",
  requiredEnv: [
    "ALTINAPI_API_KEY",
    "ALTINAPI_LICENSE_TIER",
    "ALTINAPI_REDISTRIBUTION_ALLOWED",
    "ALTINAPI_CONTRACT_VERSION",
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
  capabilities: ["REST", "PRODUCT_LEVEL", "MULTI_SOURCE", "PROTOTYPE"],
  advertisedCapabilities: ["WEBSOCKET"],
  referenceUrl: null,
  attribution:
    "Hasfiyat birden çok üst kaynağı birleştirir. Üst kaynak açıkça bildirilmediğinde veri tek bir kurumun " +
    "fiyatı gibi etiketlenmez; 'Çoklu Kaynak' olarak gösterilir.",
  requiredEnv: [
    "HASFIYAT_API_URL",
    "HASFIYAT_API_KEY",
    "HASFIYAT_LICENSE_REFERENCE",
    "HASFIYAT_REDISTRIBUTION_ALLOWED",
    "HASFIYAT_CONTRACT_VERSION",
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

/**
 * Sarraf TV Kayseri EKRAN GÖZLEMİ — deneysel, özel pilot.
 *
 * `sarraf-pro-kayseri` ile AYRI bir kimliktir. Biri ileride gelebilecek yetkili
 * API sözleşmesi, diğeri tarayıcıda gözlenen ekrandır. Aynı kimlik altında
 * tutulsalardı gözlem verisi lisanslı veri gibi görünürdü.
 *
 * `REDISTRIBUTION_LICENSED` yeteneği BİLEREK YOKTUR ve lisans durumu asla
 * LICENSED olmaz.
 */
const SARRAF_TV_SCREEN: ProviderDescriptor = {
  providerId: "sarraf-tv-kayseri-screen",
  displayName: MARKET_DISPLAY_NAMES.kayseri,
  technicalName: "Sarraf TV Kayseri ekran gözlemi",
  marketId: "kayseri",
  marketDisplayName: MARKET_DISPLAY_NAMES.kayseri,
  providerType: "SCREEN",
  capabilities: ["PRODUCT_LEVEL", "LOCAL_MARKET", "EXPERIMENTAL_SCREEN"],
  referenceUrl: "https://kaysarder.org.tr/altin-fiyatlari",
  attribution:
    "Kayseri Sarraflar ve Kuyumcular Derneği fiyat sayfasından açılan Sarraf TV Kayseri ekranının " +
    "normal tarayıcı oturumundaki gözlemidir. RESMÎ API DEĞİLDİR, lisanslı veri değildir; " +
    "yalnızca yöneticinin izin verdiği portföylerde ve özel pilotta kullanılır.",
  requiredEnv: ["PRICE_EXPERIMENTAL_SARRAF_SCREEN", "PRICE_SCREEN_WORKER_SECRET"],
  devOnly: false,
};


const TRUNCGIL: ProviderDescriptor = {
  providerId: "truncgil-turkiye",
  displayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  technicalName: "Truncgil açık finans akışı (Türkiye geneli)",
  marketId: "turkiye-genel",
  marketDisplayName: MARKET_DISPLAY_NAMES["turkiye-genel"],
  providerType: "REST",
  capabilities: ["REST", "PRODUCT_LEVEL", "PROTOTYPE"],
  advertisedCapabilities: [],
  referenceUrl: "https://finans.truncgil.com",
  // DÜRÜST ETİKETLEME: bu bağımsız bir yayıncıdır. Herhangi bir borsanın,
  // derneğin veya kuyumcunun resmî servisi DEĞİLDİR ve öyle sunulmaz.
  // Yeniden gösterim izni beyan edilmediği için kaynak deneysel sayılır.
  attribution:
    "Truncgil açık finans akışı (finans.truncgil.com). Bağımsız bir yayıncıdır; " +
    "bir borsanın, derneğin veya kuyumcunun resmî servisi değildir. Türkiye geneli " +
    "piyasa referansıdır; belirli bir kuyumcunun tezgâh fiyatı değildir.",
  // Anahtar GEREKTİRMEZ; ücretsiz ve açık uçtur.
  requiredEnv: [],
  devOnly: false,
};

/**
 * ANLIK ALTIN — KAPALIÇARŞI ÖNERİLEN TABLOSU
 *
 * NE OLDUĞU ÖLÇÜLDÜ (bkz. `docs/ANLIK_ALTIN_DOGRULAMA.md`):
 * Sayfanın adresi `/altin/kayseri` olmasına rağmen okunan tablo Kayseri
 * tezgâh fiyatı değildir. Tablonun kendi işaretleri şunu söyler:
 *   data-market="5"  data-type="harem"  id="kapalicarsi_h"
 *   tablo başlığı "Kapalı Çarşı Altın", sekme adı "KAPALIÇARŞI ÖNERİLEN"
 *
 * Aynı sayfadaki "KAYSARDER" sekmesi (data-market="4") yalnızca
 * tv.sarraf.pro iframe'i içerir: 257 bayt, sıfır fiyat hücresi. Yani bu
 * sağlayıcıdan KAYSERİ fiyatı çıkarmak MÜMKÜN DEĞİLDİR ve denenmez.
 *
 * Üç ayrı gözlemde Sarraf TV ekranıyla karşılaştırıldı: 24 hücrenin
 * 0'ı eşleşti. İki kaynak farklı piyasalardır ve öyle etiketlenir.
 */
const ANLIK_ALTIN: ProviderDescriptor = {
  providerId: "anlik-altin-kapalicarsi",
  displayName: MARKET_DISPLAY_NAMES.kapalicarsi,
  technicalName: "anlikaltinfiyatlari.com — Kapalıçarşı Önerilen tablosu",
  marketId: "kapalicarsi",
  marketDisplayName: MARKET_DISPLAY_NAMES.kapalicarsi,
  providerType: "REST",
  capabilities: ["REST", "PRODUCT_LEVEL", "PROTOTYPE"],
  advertisedCapabilities: [],
  referenceUrl: "https://anlikaltinfiyatlari.com/altin/kayseri",
  attribution:
    "anlikaltinfiyatlari.com sayfasındaki 'KAPALIÇARŞI ÖNERİLEN' tablosu (kaynak işareti: harem). " +
    "Bağımsız bir yayıncıdır; bir borsanın, derneğin veya kuyumcunun resmî servisi değildir. " +
    "Kapalıçarşı referans fiyatıdır; Kayseri tezgâh fiyatı DEĞİLDİR. Aynı sayfadaki KAYSARDER " +
    "sekmesi yalnızca Sarraf TV ekranının gömülü penceresidir ve bu sağlayıcı oradan veri okumaz.",
  // Anahtar GEREKTİRMEZ; sayfa herkese açık ve düz sunucu isteğiyle okunur.
  requiredEnv: [],
  devOnly: false,
};

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  MOCK,
  SARRAF_PRO,
  ALTINAPI,
  HASFIYAT,
  ALTINKAYNAK_DIRECT,
  HAREM_DIRECT,
  BIST_REFERENCE,
  SARRAF_TV_SCREEN,
  TRUNCGIL,
  ANLIK_ALTIN,
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
