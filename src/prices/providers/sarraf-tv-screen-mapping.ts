/**
 * SARRAF TV KAYSERİ EKRANI — GÖZLEM EŞLEMESİ (DENEYSEL)
 *
 * Bu tablo bir API sözleşmesi DEĞİLDİR. KAYSARDER'ın fiyat sayfasından açılan
 * Kayseri canlı fiyat ekranında normal tarayıcı oturumuyla GÖRÜLEN satır
 * başlıklarını kanonik ürünlere eşler.
 *
 * Kurallar:
 *  - Bu eşleme üretim (lisanslı API) sağlayıcı yolunda KULLANILMAZ.
 *  - Kaynağı gözlemdir; kanıt olarak fizibilite çalıştırmasının snapshot
 *    dosyaları saklanır (`artifacts/sarraf-tv/`).
 *  - Ekranda görülen bir başlık burada YOKSA ürün ATLANIR; benzeşen isimden
 *    tahmin yürütülmez.
 */

export const SARRAF_TV_SCREEN_MAPPING_VERSION = "sarraf-tv-screen-observed-3";

/**
 * EŞLEME GÜVEN SEVİYELERİ
 *
 * Değerlemeye girme hakkı seviyeye bağlıdır; hepsi eşit değildir.
 *
 *  EXACT             Başlık kanonik ürünü tek anlamlı belirtir ("22 AYAR").
 *                    Tek başına yön kanıtı DEĞİLDİR.
 *  NETWORK_VERIFIED  Başlık EXACT ve fiyatın yönü, tarayıcının doğal olarak
 *                    yüklediği yanıtta AYRI ALAN ADLARIYLA (buying/sales)
 *                    kanıtlanmış. Değerlemeye girebilir.
 *  GROUPED_EXPLICIT  Kaynak, aynı fiyatın birden çok ürünü kapsadığını AÇIKÇA
 *                    söylüyor. (Bu ekranda böyle bir alan bulunmadı.)
 *  OPERATOR_VERIFIED Yönetici, ekran kanıtını görüp eşlemeyi açıkça onayladı.
 *  CONVENTION        Başlık yeni/eski ayrımını yazmıyor ("ÇEYREK"). Piyasa
 *                    teamülüdür, kanıt değildir. Onaysız değerlemeye GİRMEZ.
 *  UNRESOLVED        Eşlenemez. Hiçbir zaman girmez.
 */
export type MappingConfidence =
  | "EXACT"
  | "NETWORK_VERIFIED"
  | "GROUPED_EXPLICIT"
  | "OPERATOR_VERIFIED"
  | "CONVENTION"
  | "UNRESOLVED";

/** Onay olmadan değerlemeye girebilen güven seviyeleri. */
export const VALUATION_READY_CONFIDENCE: readonly MappingConfidence[] = [
  "NETWORK_VERIFIED",
  "GROUPED_EXPLICIT",
  "OPERATOR_VERIFIED",
];

export function isValuationReady(confidence: MappingConfidence): boolean {
  return VALUATION_READY_CONFIDENCE.includes(confidence);
}

/**
 * Başlık kanonik ürünü tek anlamlı belirtiyor.
 *
 * "22 AYAR": ekranda 22 ayar gram fiyatıdır; katalogdaki tek 22 ayar ürünü
 * "22 Ayar Bilezik"tir (milyem 0,916, gram bazlı) ve ayar birebir örtüşür.
 */
export const SARRAF_TV_SCREEN_MAPPING_EXACT: Readonly<Record<string, string>> = {
  has: "has-altin",
  "has altın": "has-altin",
  "gram altın": "gram-altin",
  "22 ayar": "bilezik-22-ayar",
  "22 ayar bilezik": "bilezik-22-ayar",
  "18 ayar": "altin-18-ayar",
  "14 ayar": "altin-14-ayar",
  "8 ayar": "altin-8-ayar",
  "yeni çeyrek": "yeni-ceyrek",
  "eski çeyrek": "eski-ceyrek",
  "yeni yarım": "yeni-yarim",
  "eski yarım": "eski-yarim",
  "yeni tam": "yeni-tam",
  "eski tam": "eski-tam",
  gremse: "gremse-altin",
  "gremse altın": "gremse-altin",
  cumhuriyet: "cumhuriyet-altini",
  "cumhuriyet altını": "cumhuriyet-altini",
};

/**
 * Başlık yeni/eski ayrımını yazmıyor; piyasa teamülüne göre eşlenir.
 * Bu satırlar yönetici onayı olmadan DEĞERLEMEYE GİRMEZ.
 */
export const SARRAF_TV_SCREEN_MAPPING_CONVENTION: Readonly<Record<string, string>> = {
  çeyrek: "yeni-ceyrek",
  yarım: "yeni-yarim",
  tam: "yeni-tam",
  "tam altın": "yeni-tam",
};

/**
 * BİLEREK EŞLENMEYEN başlıklar ve nedenleri.
 * Rapor bunları "çözülemedi" olarak gösterir; tahmin YAPILMAZ.
 */
export const SARRAF_TV_SCREEN_UNMAPPED_REASONS: Readonly<Record<string, string>> = {
  "ata - reşat lira": "TEK_SATIRDA_İKİ_ÜRÜN",
  "ata - reşat beşli": "TEK_SATIRDA_İKİ_ÜRÜN",
  "24 ayar paketli": "KATALOGDA_KARŞILIĞI_BELİRSİZ",
  "külçe gümüş": "ALTIN_DEĞİL",
  dolar: "ALTIN_DEĞİL",
  euro: "ALTIN_DEĞİL",
  sterlin: "ALTIN_DEĞİL",
};

export interface ScreenMappingResult {
  productId: string;
  confidence: MappingConfidence;
}

/**
 * Ekran başlığını eşleme anahtarına çevirir.
 *
 * TÜRKÇE YEREL ZORUNLUDUR: varsayılan `toLowerCase()` "I" harfini "i" yapar ve
 * "YARIM" → "yarim" olur; eşleme anahtarı "yarım" olduğu için satır sessizce
 * eşleşmez. `toLocaleLowerCase("tr-TR")` doğru biçimde "ı" üretir.
 */
export function normalizeScreenLabel(label: string): string {
  return label.trim().toLocaleLowerCase("tr-TR").replace(/\s+/gu, " ");
}

/**
 * Başlık eşleşmiyorsa null döner; tahmin yapılmaz.
 *
 * `networkVerifiedDirection` yalnızca fiyat yönü, tarayıcının doğal olarak
 * yüklediği yanıtta ayrı alan adlarıyla kanıtlandıysa true geçilir; bu durumda
 * EXACT eşleme NETWORK_VERIFIED'a yükselir.
 */
export function screenLabelToProduct(
  label: string,
  options: { networkVerifiedDirection?: boolean } = {},
): ScreenMappingResult | null {
  const key = normalizeScreenLabel(label);
  const exact = SARRAF_TV_SCREEN_MAPPING_EXACT[key];
  if (exact) {
    return {
      productId: exact,
      confidence: options.networkVerifiedDirection === true ? "NETWORK_VERIFIED" : "EXACT",
    };
  }
  const convention = SARRAF_TV_SCREEN_MAPPING_CONVENTION[key];
  if (convention) return { productId: convention, confidence: "CONVENTION" };
  return null;
}

/** Eşlenmeyen başlık için bilinen bir gerekçe varsa döner. */
export function unmappedReason(label: string): string | null {
  return SARRAF_TV_SCREEN_UNMAPPED_REASONS[normalizeScreenLabel(label)] ?? null;
}
