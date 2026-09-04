/**
 * HİBRİT KAYSERİ DEĞERLEMESİ — ÜRÜN BAŞINA KAYNAK PLANI
 *
 * "Hangi ürünün fiyatı hangi kaynaktan gelir?" sorusunun TEK cevabı burasıdır.
 * Bileşenlere, sunucuya veya arayüze dağıtılmaz.
 *
 * DEĞİŞMEZ KURALLAR
 *
 *  1. BİR ÜRÜN = BİR KAYNAK.
 *     Bir ürünün alış fiyatı bir kaynaktan, satış fiyatı başka kaynaktan
 *     ALINMAZ. Plan ürün başına tek sağlayıcı belirler; alış ve satış hep o
 *     sağlayıcının aynı kaydından gelir.
 *
 *  2. SESSİZ GEÇİŞ YOKTUR.
 *     Planlanan kaynak veri vermiyorsa ürün fiyatsız kalır. Başka kaynağın
 *     fiyatı o ürüne YAZILMAZ; "bayat" veya "kullanılamıyor" gösterilir.
 *
 *  3. KAYNAK SEÇİMİ ÖLÇÜME DAYANIR.
 *     Kayseri ekranında İKİ YÖNLÜ ve yönü doğrulanmış satırı olan ürünler
 *     Sarraf TV'den gelir. Ekranda olmayan ürünler için sırayla Kapalıçarşı
 *     tablosu, sonra Türkiye geneli akışı kullanılır — ama bu bir "yedek"
 *     değil, ürün başına ÖNCEDEN VERİLMİŞ ve sabit bir karardır.
 */

/** Kullanıcıya gösterilen plan adı. Teknik sağlayıcı adı değildir. */
export const VALUATION_PLAN_NAME = "Hibrit Kayseri Değerlemesi";

export const VALUATION_PLAN_DESCRIPTION =
  "Kayseri ekranında bulunan ürünler Sarraf TV Kayseri fiyatıyla, bulunmayan ürünler " +
  "Kapalıçarşı ve Türkiye geneli referans fiyatlarıyla hesaplanır.";

/** Hibrit planın anlık görüntüde kullandığı sanal kimlik. */
export const HYBRID_PROVIDER_ID = "hibrit-kayseri";
export const HYBRID_MARKET_ID = "hibrit";

export const SCREEN_PROVIDER_CODE = "sarraf-tv-kayseri-screen";
export const KAPALICARSI_PROVIDER_CODE = "anlik-altin-kapalicarsi";
export const TURKIYE_PROVIDER_CODE = "truncgil-turkiye";

/** Planın kullandığı bütün sağlayıcılar (izin ve alım denetimi bu liste üzerinden). */
export const PLAN_PROVIDER_CODES = [
  SCREEN_PROVIDER_CODE,
  KAPALICARSI_PROVIDER_CODE,
  TURKIYE_PROVIDER_CODE,
] as const;

export type PlanProviderCode = (typeof PLAN_PROVIDER_CODES)[number];

/**
 * ÜRÜN → KAYNAK
 *
 * Kayseri ekranından gelenler (ekranda iki yönlü satırı var):
 *   ÇEYREK / YARIM / TAM ALTIN → yönetici onaylı kategori fiyatı
 *   GREMSE                     → doğrudan
 *   ATA - REŞAT LİRA           → kaynağın açıkça grupladığı satır
 *   ATA - REŞAT BEŞLİ          → aynı gruplama
 *
 * Kapalıçarşı tablosundan gelenler (ekranda İKİ YÖNLÜ satırı yok):
 *   Gram Altın  — ekranda yalnız tek fiyatlı "HAS" ve "22 AYAR" var
 *   Has Altın   — aynı sebep
 *   14 Ayar     — ekranda tek fiyat
 *
 * Türkiye geneli akışından gelenler (ilk iki kaynakta hiç yok):
 *   Cumhuriyet, Hamit, İkibuçuk, 18 Ayar
 *
 * HİÇBİR KAYNAKTA OLMAYANLAR (bilerek fiyatsız):
 *   kulce-24-ayar, kulce-ozel-gramaj — hiçbir kaynak külçe satırı yayımlamıyor
 *   bilezik-22-ayar                  — ekranda tek fiyat; Kapalıçarşı'daki
 *                                      "22 Ayar Altın" hurda fiyatıdır, bilezik
 *                                      işçilik payı taşır, eşitlenemez
 *   altin-8-ayar                     — ekranda tek fiyat, yön kanıtlanamıyor
 */
export const VALUATION_SOURCE_PLAN: Readonly<Record<string, PlanProviderCode>> = {
  // --- Kayseri yerel tezgâh ---
  "yeni-ceyrek": SCREEN_PROVIDER_CODE,
  "eski-ceyrek": SCREEN_PROVIDER_CODE,
  "yeni-yarim": SCREEN_PROVIDER_CODE,
  "eski-yarim": SCREEN_PROVIDER_CODE,
  "yeni-tam": SCREEN_PROVIDER_CODE,
  "eski-tam": SCREEN_PROVIDER_CODE,
  "gremse-altin": SCREEN_PROVIDER_CODE,
  "ata-altin": SCREEN_PROVIDER_CODE,
  "resat-altin": SCREEN_PROVIDER_CODE,
  "besli-altin": SCREEN_PROVIDER_CODE,

  // --- Kapalıçarşı referansı ---
  "gram-altin": KAPALICARSI_PROVIDER_CODE,
  "has-altin": KAPALICARSI_PROVIDER_CODE,
  "altin-14-ayar": KAPALICARSI_PROVIDER_CODE,

  // --- Türkiye geneli ---
  "cumhuriyet-altini": TURKIYE_PROVIDER_CODE,
  "hamit-altin": TURKIYE_PROVIDER_CODE,
  "ikibucuk-altin": TURKIYE_PROVIDER_CODE,
  "altin-18-ayar": TURKIYE_PROVIDER_CODE,
};

/**
 * ORTAK KATEGORİ FİYATI — SHARED_CATEGORY_QUOTE
 *
 * Kayseri ekranı "ÇEYREK / YARIM / TAM ALTIN" satırlarında yeni-eski ayrımı
 * YAPMAZ; tek bir kategori fiyatı yayımlar. Bu yüzden eski ziynetler, aynı
 * kategorinin ana ürününün fiyatıyla değerlenir.
 *
 * Bu bir TAHMİN DEĞİLDİR: kaynak zaten tek fiyat veriyor. Fiyat türetilmez,
 * ölçeklenmez; birebir aynı kayıt kullanılır ve arayüzde bu durum açıkça
 * belirtilir.
 */
export const SHARED_CATEGORY_QUOTE: Readonly<Record<string, string>> = {
  "eski-ceyrek": "yeni-ceyrek",
  "eski-yarim": "yeni-yarim",
  "eski-tam": "yeni-tam",
};

export const SHARED_CATEGORY_NOTE =
  "Kayseri ekranı yeni/eski ayrımı yayımlamadığı için ortak kategori fiyatı kullanılır.";

/**
 * GÖRÜNÜM GRUPLARI
 *
 * Katalogda `yeni-ceyrek` ve `eski-ceyrek` ayrı kayıtlardır ve öyle kalır —
 * yıkıcı bir birleştirme migration'ı YAPILMAZ. Kullanıcı arayüzünde ise tek
 * bir "Çeyrek Altın" adı görünür.
 */
export interface DisplayGroup {
  id: string;
  label: string;
  /** Yeni kayıt açılırken kullanılan kanonik ürün. */
  primaryProductId: string;
  /** Bu ada karşılık gelen bütün katalog ürünleri. */
  memberProductIds: readonly string[];
}

/**
 * VARSAYILAN ARAYÜZDE GÖRÜNEN ALTI ÜRÜN.
 *
 * Katalogdaki diğer ürünler SİLİNMEZ; yalnızca varsayılan listede görünmez.
 * Kullanıcının elinde bu ürünlerden kayıt varsa "Diğer varlıklar" altında
 * gösterilir ve satılabilir.
 */
export const PRIMARY_DISPLAY_GROUPS: readonly DisplayGroup[] = [
  { id: "gram", label: "Gram Altın", primaryProductId: "gram-altin", memberProductIds: ["gram-altin"] },
  {
    id: "ceyrek",
    label: "Çeyrek Altın",
    primaryProductId: "yeni-ceyrek",
    memberProductIds: ["yeni-ceyrek", "eski-ceyrek"],
  },
  {
    id: "yarim",
    label: "Yarım Altın",
    primaryProductId: "yeni-yarim",
    memberProductIds: ["yeni-yarim", "eski-yarim"],
  },
  { id: "tam", label: "Tam Altın", primaryProductId: "yeni-tam", memberProductIds: ["yeni-tam", "eski-tam"] },
  { id: "ata", label: "Ata Altın", primaryProductId: "ata-altin", memberProductIds: ["ata-altin"] },
  { id: "gremse", label: "Gremse Altın", primaryProductId: "gremse-altin", memberProductIds: ["gremse-altin"] },
];

const GROUP_BY_MEMBER = new Map<string, DisplayGroup>();
for (const group of PRIMARY_DISPLAY_GROUPS) {
  for (const member of group.memberProductIds) GROUP_BY_MEMBER.set(member, group);
}

/** Varsayılan arayüzde gösterilen ürün kimlikleri (grup üyeleri dâhil). */
export const PRIMARY_PRODUCT_IDS: readonly string[] = PRIMARY_DISPLAY_GROUPS.flatMap(
  (group) => group.memberProductIds,
);

export function displayGroupOf(productId: string): DisplayGroup | null {
  return GROUP_BY_MEMBER.get(productId) ?? null;
}

export function isPrimaryProduct(productId: string): boolean {
  return GROUP_BY_MEMBER.has(productId);
}

/**
 * Arayüzde gösterilecek ürün adı.
 *
 * Grup üyeleri grup adıyla gösterilir ("Yeni Çeyrek" → "Çeyrek Altın").
 * `distinguishMembers` verildiğinde, aynı gruptan birden çok ürün elde varsa
 * satırların ayırt edilebilmesi için katalog adı parantez içinde eklenir —
 * kayıtlar birbirine karışmasın diye.
 */
export function displayProductName(
  productId: string,
  catalogName: string,
  options: { distinguish?: boolean } = {},
): string {
  const group = GROUP_BY_MEMBER.get(productId);
  if (!group) return catalogName;
  if (options.distinguish === true && group.memberProductIds.length > 1) {
    return `${group.label} (${catalogName})`;
  }
  return group.label;
}

/** Bir ürünün planlanan kaynağı; planda yoksa null (fiyatsız kalır). */
export function plannedProviderFor(productId: string): PlanProviderCode | null {
  return VALUATION_SOURCE_PLAN[productId] ?? null;
}

/**
 * KAYNAK ROZETLERİ
 *
 * Kullanıcıya teknik sağlayıcı kimliği, lisans durumu veya güven seviyesi
 * (NETWORK_VERIFIED, GROUPED_EXPLICIT ...) GÖSTERİLMEZ.
 */
export interface SourceBadge {
  label: string;
  description: string;
}

export const SOURCE_BADGES: Readonly<Record<string, SourceBadge>> = {
  [SCREEN_PROVIDER_CODE]: {
    label: "Kayseri — Sarraf TV",
    description: "Kayseri sarraflarının canlı ekranında görünen tezgâh fiyatı.",
  },
  [KAPALICARSI_PROVIDER_CODE]: {
    label: "Kapalıçarşı — Anlık Altın",
    description:
      "anlikaltinfiyatlari.com sayfasındaki Kapalıçarşı Önerilen tablosu. Kayseri tezgâh fiyatı değildir.",
  },
  [TURKIYE_PROVIDER_CODE]: {
    label: "Türkiye Geneli — Trunçgil",
    description: "Türkiye geneli piyasa referansı. Belirli bir kuyumcunun tezgâh fiyatı değildir.",
  },
};

export function sourceBadgeFor(providerCode: string | null | undefined): SourceBadge | null {
  if (!providerCode) return null;
  return SOURCE_BADGES[providerCode] ?? null;
}

/** Kaç ürünün hangi kaynaktan değerlendiğini özetler (kullanıcıya tek cümle). */
export function summarizeSources(providerCodes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of providerCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
  const parts: string[] = [];
  for (const code of PLAN_PROVIDER_CODES) {
    const count = counts.get(code);
    if (!count) continue;
    parts.push(`${count} ürün ${SOURCE_BADGES[code]!.label}`);
  }
  return parts.length === 0 ? "" : `${parts.join(", ")} fiyatıyla değerleniyor.`;
}
