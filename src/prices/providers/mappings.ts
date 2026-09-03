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

export const SARRAFPRO_MAPPING_VERSION = "sarrafpro-kayseri-1";

/**
 * Kayseri yerel piyasa sembolleri.
 * Kesin sembol listesi yetkili sözleşmeyle birlikte gelir; eşleme sözleşme
 * geldiğinde bu tabloda güncellenir ve `mappingVersion` artırılır.
 */
export const SARRAFPRO_MAPPING: Readonly<Record<string, string>> = {
  GRAM: "gram-altin",
  GRAM_ALTIN: "gram-altin",
  HAS: "has-altin",
  HAS_ALTIN: "has-altin",
  KULCE: "kulce-24-ayar",
  BILEZIK_22: "bilezik-22-ayar",
  AYAR_18: "altin-18-ayar",
  AYAR_14: "altin-14-ayar",
  AYAR_8: "altin-8-ayar",
  CEYREK: "yeni-ceyrek",
  CEYREK_ESKI: "eski-ceyrek",
  YARIM: "yeni-yarim",
  YARIM_ESKI: "eski-yarim",
  TAM: "yeni-tam",
  TAM_ESKI: "eski-tam",
  CUMHURIYET: "cumhuriyet-altini",
  ATA: "ata-altin",
  RESAT: "resat-altin",
  HAMIT: "hamit-altin",
  IKIBUCUK: "ikibucuk-altin",
  BESLI: "besli-altin",
  GREMSE: "gremse-altin",
};
