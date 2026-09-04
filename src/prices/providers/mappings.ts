/**
 * SEMBOL → KANONİK ÜRÜN EŞLEMELERİ
 *
 * Her sağlayıcının kendi sembol adları vardır. Eşleme burada AÇIKÇA tanımlanır;
 * tahmin edilmez. Eşlenmemiş bir sembol sessizce başka ürüne yazılmaz, atlanır.
 * `mappingVersion` değişirse eski kayıtların hangi eşlemeyle üretildiği izlenebilir
 * (`price_product_mappings.mapping_version`).
 */

export const ALTINAPI_MAPPING_VERSION = "altinapi-1";

/** AltinAPI sembolleri (bağımsız veri sağlayıcısı; bir kurumun resmî servisi değildir). */
export const ALTINAPI_MAPPING: Readonly<Record<string, string>> = {
  GRAM_ALTIN: "gram-altin",
  GRAMALTIN: "gram-altin",
  "GRAM ALTIN": "gram-altin",
  HAS_ALTIN: "has-altin",
  HASALTIN: "has-altin",
  KULCE_ALTIN: "kulce-24-ayar",
  "24_AYAR_KULCE": "kulce-24-ayar",
  AYAR22: "bilezik-22-ayar",
  "22_AYAR_BILEZIK": "bilezik-22-ayar",
  AYAR18: "altin-18-ayar",
  AYAR14: "altin-14-ayar",
  AYAR8: "altin-8-ayar",
  CEYREK_YENI: "yeni-ceyrek",
  YENI_CEYREK: "yeni-ceyrek",
  CEYREK_ESKI: "eski-ceyrek",
  ESKI_CEYREK: "eski-ceyrek",
  YARIM_YENI: "yeni-yarim",
  YENI_YARIM: "yeni-yarim",
  YARIM_ESKI: "eski-yarim",
  ESKI_YARIM: "eski-yarim",
  TAM_YENI: "yeni-tam",
  YENI_TAM: "yeni-tam",
  TAM_ESKI: "eski-tam",
  ESKI_TAM: "eski-tam",
  CUMHURIYET: "cumhuriyet-altini",
  CUMHURIYET_ALTINI: "cumhuriyet-altini",
  ATA: "ata-altin",
  ATA_ALTIN: "ata-altin",
  RESAT: "resat-altin",
  RESAT_ALTIN: "resat-altin",
  HAMIT: "hamit-altin",
  HAMIT_ALTIN: "hamit-altin",
  IKIBUCUK: "ikibucuk-altin",
  BESLI: "besli-altin",
  GREMSE: "gremse-altin",
};

export const HASFIYAT_MAPPING_VERSION = "hasfiyat-1";

/** Hasfiyat sembolleri (çoklu kaynak birleşimi). */
export const HASFIYAT_MAPPING: Readonly<Record<string, string>> = {
  ...ALTINAPI_MAPPING,
  ALTIN: "gram-altin",
  HAS: "has-altin",
  KULCE: "kulce-24-ayar",
  BILEZIK: "bilezik-22-ayar",
};

export const SARRAFPRO_MAPPING_VERSION = "sarrafpro-kayseri-unmapped-1";

/**
 * Kayseri yerel piyasa (Sarraf Pro) ÜRETİM eşlemesi.
 *
 * BİLEREK BOŞTUR. Önceki sürümde buradaki semboller (GRAM, CEYREK, ATA...)
 * yetkili sözleşmeden DOĞRULANMAMIŞ TAHMİNLERDİ. Tahmini bir sembol tablosu,
 * gerçek API'de farklı bir sembolle eşleşirse fiyat sessizce YANLIŞ ürüne
 * yazılabilirdi.
 *
 * Eşleme yalnızca yetkili API/XML sözleşmesi geldiğinde, sözleşmedeki sembol
 * listesiyle doldurulur ve `SARRAFPRO_MAPPING_VERSION` artırılır.
 *
 * Ekran fizibilitesinde GÖZLENEN metinler ayrıdır ve üretim yolunda kullanılmaz:
 * bkz. `src/prices/providers/sarraf-tv-screen-mapping.ts`.
 */
export const SARRAFPRO_MAPPING: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------

export const TRUNCGIL_MAPPING_VERSION = "truncgil-v4-1";

/**
 * TRUNCGIL SEMBOLLERİ → KANONİK ÜRÜNLER
 *
 * DİKKAT: Kaynak, `Type` alanında GUMUS, XU100, BRENT, ONS ve DBITCOIN gibi
 * satırları da "Gold" olarak etiketliyor. Bu yüzden `Type` alanına GÜVENİLMEZ;
 * yalnızca aşağıdaki AÇIK beyaz liste kullanılır. Listede olmayan sembol
 * sessizce başka ürüne yazılmaz, atlanır.
 *
 * Eşlenmeyenler ve nedeni:
 *   GUMUS      gümüştür, altın portföyüne katılmaz
 *   XU100      borsa endeksi
 *   ONS/BRENT  altın portföyü ürünü değil
 *   YIA        anlamı belirsiz (hangi ayar olduğu kaynakta yazmıyor)
 *   22 ayar    kaynak 22 ayar satırı yayımlamıyor
 *   8 ayar     kaynak 8 ayar satırı yayımlamıyor
 *   külçe      kaynak külçe satırı yayımlamıyor
 */
export const TRUNCGIL_MAPPING: Readonly<Record<string, string>> = {
  GRA: "gram-altin",
  HAS: "has-altin",
  "14AYARALTIN": "altin-14-ayar",
  "18AYARALTIN": "altin-18-ayar",
  CEYREKALTIN: "yeni-ceyrek",
  YARIMALTIN: "yeni-yarim",
  TAMALTIN: "yeni-tam",
  CUMHURIYETALTINI: "cumhuriyet-altini",
  ATAALTIN: "ata-altin",
  RESATALTIN: "resat-altin",
  HAMITALTIN: "hamit-altin",
  IKIBUCUKALTIN: "ikibucuk-altin",
  BESLIALTIN: "besli-altin",
  GREMSEALTIN: "gremse-altin",
};

/**
 * ESKİ ZİYNET EŞLEMELERİ — GROUPED_EXPLICIT
 *
 * Kaynak "ÇEYREK / YARIM / TAM" için TEK fiyat yayımlar; yeni-eski ayrımı
 * yapmaz. Eski ziynetler aynı ayar (0.916) ve neredeyse aynı gramajdadır, bu
 * yüzden aynı kaynak fiyatı her ikisine de uygulanır.
 *
 * Bu bir TAHMİN DEĞİL, açık bir gruplamadır ve kullanıcıya arayüzde
 * "kaynak yeni ve eskiyi ayırmıyor" uyarısıyla birlikte gösterilir.
 */
export const TRUNCGIL_GROUPED_MAPPING: Readonly<Record<string, string>> = {
  CEYREKALTIN: "eski-ceyrek",
  YARIMALTIN: "eski-yarim",
  TAMALTIN: "eski-tam",
};
