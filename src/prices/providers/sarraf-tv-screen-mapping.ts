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

/**
 * Sürüm 4: "ATA - REŞAT LİRA" ve "ATA - REŞAT BEŞLİ" satırları GROUPED_EXPLICIT
 * olarak eşlendi (aşağıdaki gerekçeye bakın). Sürüm değiştiği için önceki
 * sürümde kaydedilmiş yönetici onayları geçersizdir ve yeniden alınır.
 */
export const SARRAF_TV_SCREEN_MAPPING_VERSION = "sarraf-tv-screen-observed-4";

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
 *                    söylüyor. Bu ekranda ayrı bir alanla değil, başlığın
 *                    kendisiyle beyan edilir ("ATA - REŞAT LİRA"); tablo
 *                    aşağıda: SARRAF_TV_SCREEN_MAPPING_GROUPED.
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
 * KAYNAĞIN AÇIKÇA GRUPLADIĞI SATIRLAR — GROUPED_EXPLICIT
 *
 * Ekran bu satırlarda TEK fiyatın BİRDEN ÇOK ürünü kapsadığını başlıkta
 * AÇIKÇA yazar: "ATA - REŞAT LİRA". Bu bir tahmin değil, kaynağın kendi
 * beyanıdır — gruplama kuralının tanımı budur.
 *
 * Neden güvenli:
 *  - Ata ve Reşat lirası katalogda da aynı gramaj (7,216 g) ve aynı ayardadır
 *    (0,916); ürünler fiziksel olarak birbirinin dengidir.
 *  - Ölçüm: ekran 45.350/47.600 gösterirken Kapalıçarşı referansı Ata için
 *    45.464/46.028 gösteriyordu — aynı büyüklük sınıfı, tutarlı.
 *
 * Beşli satırı aynı mantıkla 5 liralık ürüne (36,08 g) eşlenir.
 *
 * "24 AYAR PAKETLİ" BİLEREK DIŞARIDA: kaç gramlık paket olduğu ekranda
 * yazmıyor ve katalogdaki karşılığı belirsiz.
 */
export const SARRAF_TV_SCREEN_MAPPING_GROUPED: Readonly<Record<string, readonly string[]>> = {
  "ata - reşat lira": ["ata-altin", "resat-altin"],
  "ata - reşat beşli": ["besli-altin"],
};

/**
 * BİLEREK EŞLENMEYEN başlıklar ve nedenleri.
 * Rapor bunları "çözülemedi" olarak gösterir; tahmin YAPILMAZ.
 */
export const SARRAF_TV_SCREEN_UNMAPPED_REASONS: Readonly<Record<string, string>> = {
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

/** Bir ekran satırının kapsadığı ürünler. Gruplu satırlarda birden çok olur. */
export interface ScreenMappingGroup {
  productIds: readonly string[];
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
export function screenLabelToProducts(
  label: string,
  options: { networkVerifiedDirection?: boolean } = {},
): ScreenMappingGroup | null {
  const key = normalizeScreenLabel(label);
  const exact = SARRAF_TV_SCREEN_MAPPING_EXACT[key];
  if (exact) {
    return {
      productIds: [exact],
      confidence: options.networkVerifiedDirection === true ? "NETWORK_VERIFIED" : "EXACT",
    };
  }
  const grouped = SARRAF_TV_SCREEN_MAPPING_GROUPED[key];
  if (grouped) return { productIds: grouped, confidence: "GROUPED_EXPLICIT" };
  const convention = SARRAF_TV_SCREEN_MAPPING_CONVENTION[key];
  if (convention) return { productIds: [convention], confidence: "CONVENTION" };
  return null;
}

/** Tek ürünlü kısayol. Gruplu satırlarda grubun İLK ürününü döner. */
export function screenLabelToProduct(
  label: string,
  options: { networkVerifiedDirection?: boolean } = {},
): ScreenMappingResult | null {
  const group = screenLabelToProducts(label, options);
  if (!group || group.productIds.length === 0) return null;
  return { productId: group.productIds[0]!, confidence: group.confidence };
}

/** Eşlenmeyen başlık için bilinen bir gerekçe varsa döner. */
export function unmappedReason(label: string): string | null {
  return SARRAF_TV_SCREEN_UNMAPPED_REASONS[normalizeScreenLabel(label)] ?? null;
}
