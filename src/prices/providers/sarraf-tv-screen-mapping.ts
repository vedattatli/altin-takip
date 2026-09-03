/**
 * SARRAF TV KAYSERİ EKRANI — GÖZLEM EŞLEMESİ (DENEYSEL)
 *
 * Bu tablo bir API sözleşmesi DEĞİLDİR. KAYSARDER'ın fiyat sayfasından açılan
 * Kayseri canlı fiyat ekranında normal tarayıcı oturumuyla GÖRÜLEN satır
 * başlıklarını kanonik ürünlere eşler.
 *
 * Kurallar:
 *  - Bu eşleme üretim sağlayıcı yolunda KULLANILMAZ; yalnızca
 *    `tools/experimental/sarraf-tv-kayseri` fizibilite aracı okur.
 *  - Kaynağı gözlemdir; kanıt olarak fizibilite çalıştırmasının snapshot
 *    dosyaları saklanır (`artifacts/sarraf-tv/`).
 *  - Ekranda görülen bir başlık burada YOKSA ürün ATLANIR; benzeşen isimden
 *    tahmin yürütülmez.
 *
 * İKİ AYRI GÜVEN SEVİYESİ vardır ve karıştırılmaz:
 *
 *  EXACT      — başlık kanonik ürünü tek anlamlı biçimde belirtir ("22 AYAR").
 *  CONVENTION — başlık yeni/eski ayrımını YAZMIYOR ("ÇEYREK"). Türkiye
 *               kuyumcu ekranlarında niteliksiz "çeyrek" yeni çeyrektir; bu bir
 *               piyasa teamülüdür, sözleşmeyle doğrulanmış bir eşleme değildir.
 *               Bu satırlar ayrı işaretlenir ve raporda AYRICA listelenir;
 *               teyit alınmadan üretimde kullanılmaz.
 */

export const SARRAF_TV_SCREEN_MAPPING_VERSION = "sarraf-tv-screen-observed-2";

/** Başlık kanonik ürünü tek anlamlı belirtiyor. */
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
  cumhuriyet: "cumhuriyet-altini",
  "cumhuriyet altını": "cumhuriyet-altini",
};

/**
 * Başlık yeni/eski ayrımını yazmıyor; piyasa teamülüne göre eşlenir.
 * Bu satırlar raporda AYRI gösterilir ve teyit gerektirir.
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
};

export type MappingConfidence = "EXACT" | "CONVENTION";

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

/** Başlık eşleşmiyorsa null döner; tahmin yapılmaz. */
export function screenLabelToProduct(label: string): ScreenMappingResult | null {
  const key = normalizeScreenLabel(label);
  const exact = SARRAF_TV_SCREEN_MAPPING_EXACT[key];
  if (exact) return { productId: exact, confidence: "EXACT" };
  const convention = SARRAF_TV_SCREEN_MAPPING_CONVENTION[key];
  if (convention) return { productId: convention, confidence: "CONVENTION" };
  return null;
}

/** Eşlenmeyen başlık için bilinen bir gerekçe varsa döner. */
export function unmappedReason(label: string): string | null {
  return SARRAF_TV_SCREEN_UNMAPPED_REASONS[normalizeScreenLabel(label)] ?? null;
}
