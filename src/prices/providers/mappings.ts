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

// ---------------------------------------------------------------------------

export const ANLIK_ALTIN_MAPPING_VERSION = "anlik-altin-kapalicarsi-3";

/**
 * ANLIK ALTIN "KAPALIÇARŞI ÖNERİLEN" TABLOSU → KANONİK ÜRÜNLER
 *
 * Anahtarlar sayfadaki `data-name="<ANAHTAR>_alis|satis"` öneklerdir; ekranda
 * görünen Türkçe başlık DEĞİLDİR. Başlık metni sayfa tasarımıyla değişebilir,
 * `data-name` ise veri sözleşmesidir.
 *
 * Beyaz liste AÇIKTIR: listede olmayan sembol sessizce başka ürüne yazılmaz.
 *
 * Eşlenmeyenler ve nedeni:
 *   HGUMUSTRY / HXAGUSD  gümüştür, altın portföyüne katılmaz
 *   HXAUXAG              orandır, fiyat değildir
 *   HONS                 dolar bazlı ons; TL ürün değildir
 *
 * SÜRÜM 3: HAYAR22 (22 Ayar Altın) EKLENDİ.
 *
 * Daha önce "tabloda hurda/işlenmiş ayrımı yazmıyor" gerekçesiyle dışarıda
 * bırakılmıştı; asıl sorun katalogda yalnızca "22 Ayar Bilezik" olmasıydı ve
 * bilezik işçilik payı taşıdığı için hurda fiyatıyla eşleşmiyordu. Katalogda
 * artık ayrı bir "22 Ayar Altın" (gram) ürünü var ve bu satır ona eşlenir.
 *
 * Ölçüm (2026-09-04): 6279.18 / 6492.15, makas ~%3,4. Gram altın 6868 × 0,916
 * = 6291 TL saf altın karşılığı; alış onun hemen altında, satış üstünde. Yani
 * gerçek bir alış/satış makası (14 ayar satırındaki karışıklık burada yok).
 *   HCEYREK_ESKI         aşağıda ayrı ele alınıyor
 *   HAYAR14              SÜRÜM 2'DE ÇIKARILDI — aşağıdaki ölçüme bakın
 *
 * SÜRÜM 2: HAYAR14 (14 Ayar Altın) kaldırıldı.
 *
 * Ölçüm (2026-09-04): kaynak bu satırda `3781.52 / 5010.26` yayımlıyor, yani
 * %32 makas. Diğer satırlarda makas ~%1. Sebebi tabloda iki FARKLI şeyin yan
 * yana konması:
 *   gram altın 6868 × 0,585 (14 ayar milyemi) = 4018 TL saf altın karşılığı
 *   alış  3781 → saf altın değerinin ALTINDA, hurda alış fiyatı
 *   satış 5010 → saf altın değerinin %25 ÜSTÜNDE, işçilikli takı satışı
 *
 * Bu bir alış/satış makası değildir; hurda alışı ile perakende satışıdır.
 * Kalite kapısı zaten SPREAD_TOO_WIDE ile reddediyordu, ama her koşumda
 * karantina kaydı üretiyordu. Eşlemeden çıkarmak dürüst olanıdır: kaynak bu
 * ürün için iki yönlü fiyat YAYIMLAMIYOR.
 *
 * Trunçgil de çözüm değil: orada 14 ayar `3933.27 / 3937.67`, makas %0,1 —
 * tezgâh fiyatı değil piyasa referans kuru. Bozdurma ile yeniden alımı aynı
 * göstermek kullanıcıyı yanıltır.
 */
export const ANLIK_ALTIN_MAPPING: Readonly<Record<string, string>> = {
  HGRAM: "gram-altin",
  HHAS: "has-altin",
  HAYAR22: "altin-22-ayar",
  HCEYREK: "yeni-ceyrek",
  HCEYREK_ESKI: "eski-ceyrek",
  HYARIM: "yeni-yarim",
  HTEK: "yeni-tam",
  HATA: "ata-altin",
  HATA5: "besli-altin",
  HGREMSE: "gremse-altin",
};

/**
 * Tablonun kimlik mührü.
 *
 * Sayfada ÜÇ ayrı blok var ve yalnızca biri okunur:
 *   data-market="3"  data-type="kuyumcu"                    (gizli, Altınkaynak)
 *   data-market="5"  data-type="harem"   id="kapalicarsi_h" (OKUNAN TABLO)
 *   data-market="4"  data-type="KAYSARDER: Kayseri Sarraflar" (yalnız iframe)
 *
 * Bu üç değer birlikte doğrulanır. Sayfa yeniden düzenlenir ve blok kayarsa
 * fail closed olunur; "yakın görünen" başka bir tablo okunmaz.
 */
export const ANLIK_ALTIN_TABLE_CONTRACT = {
  market: "5",
  dataType: "harem",
  tableId: "kapalicarsi_h",
} as const;
