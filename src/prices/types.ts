/**
 * Fiyat sağlayıcı sözleşmesi.
 *
 * TEMEL KURALLAR
 * 1. liquidationPrice ve replacementPrice birbirine ÇEVRİLMEZ, türetilmez, yer değiştirmez.
 *    liquidationPrice = kuyumcunun kullanıcıdan ALDIĞI fiyat (bozdurma değeri, gerçekleşmemiş K/Z)
 *    replacementPrice = kuyumcunun kullanıcıya SATTIĞI fiyat (yeniden alım değeri)
 *    Kullanıcının gerçek işlem fiyatları için ayrı isimler kullanılır:
 *    quotedAcquisitionUnitPrice / effectiveAcquisitionUnitCost (alış) ve
 *    quotedDisposalUnitPrice / effectiveNetUnitProceeds (satış). Piyasa alanlarıyla karıştırılmaz.
 * 2. Bir sağlayıcı başarısız olursa BAŞKA BİR PİYASANIN fiyatı sessizce
 *    gösterilmez. Sonuç "unavailable" döner ve arayüz bunu açıkça yazar.
 * 3. Test verisi hiçbir koşulda gerçek piyasa verisi gibi etiketlenmez.
 * 4. Fiyatlar ONDALIK DİZE olarak taşınır; kayan nokta hesabına girmez.
 * 5. Zamanı geçersiz, fazla eski veya gelecekte olan anlık görüntü "güncel" sayılmaz.
 */

export type PriceStatus = "ok" | "stale" | "unavailable";

/** Sağlayıcı saatiyle küçük sapmalara tolerans; bunun ötesindeki "gelecek" zaman bayat sayılır. */
export const SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface PriceQuote {
  productId: string;
  /** Kuyumcunun kullanıcıdan altını aldığı fiyat (TL, ondalık dize). Bozdurma değeri. */
  liquidationPrice: string;
  /** Kuyumcunun kullanıcıya altını sattığı fiyat (TL, ondalık dize). Yeniden alım değeri. */
  replacementPrice: string;
  currency: "TRY";
  /** Fiyatın alındığı piyasa. Test verisinde "TEST". */
  market: string;
  /** Sağlayıcı kimliği. Örn. "mock". */
  provider: string;
  /** Sağlayıcının bildirdiği fiyat zamanı (ISO). */
  providerTimestamp: string;
  /** Uygulamanın veriyi çektiği zaman (ISO). */
  fetchedAt: string;
  status: PriceStatus;
}

export interface PriceProviderMeta {
  id: string;
  /** Arayüzde "Fiyat kaynağı" olarak gösterilen etiket. */
  label: string;
  /** Piyasa kimliği. Farklı piyasalar birbirinin yerine kullanılamaz. */
  market: string;
  /**
   * Kaynak, yeniden gösterim izni beyan edilmiş LİSANSLI bir servis mi?
   *
   * DİKKAT — bu alan "veri gerçek mi" sorusunun cevabı DEĞİLDİR. Kayseri
   * tezgâh fiyatı gerçek piyasa verisidir ama lisanslı değildir. İkisini
   * karıştırmak, gerçek fiyatı "gerçek değil" diye etiketlemeye yol açardı.
   * Uyarı metni için `isTestData` kullanılır.
   */
  isRealMarketData: boolean;
  /**
   * true ise bu veri UYDURULMUŞTUR (test sağlayıcısı).
   * Arayüz bu durumda "Gerçek piyasa verisi değil" uyarısını göstermek
   * ZORUNDADIR. Lisanssız ama gerçek kaynaklarda false'tur.
   */
  isTestData?: boolean;
  /** Kullanıcıya gösterilecek kısa açıklama. */
  disclaimer: string;
  /** Verinin bayatlamış sayılacağı süre (ms). */
  staleAfterMs: number;
  /**
   * HİBRİT PLAN — ürün başına BEYAN EDİLMİŞ kaynak.
   *
   * Alan doluysa anlık görüntü birden çok sağlayıcıdan derlenmiştir. O zaman
   * bir quote'un sağlayıcısı, anlık görüntünün sanal kimliğiyle DEĞİL, bu
   * plandaki ürüne ait girdiyle karşılaştırılır.
   *
   * Bu, "başka piyasanın fiyatı sessizce kullanılmaz" güvencesini
   * GEVŞETMEZ, tersine KEskinleştirir: plan doluyken planda ADI GEÇMEYEN
   * hiçbir ürün değerlemeye giremez. Fiyatın hangi kaynaktan geleceği,
   * fiyat gelmeden ÖNCE yazılmıştır.
   */
  memberProviders?: Readonly<Record<string, PriceSourceMember>>;
}

export interface PriceSourceMember {
  /** Bu ürün için tek geçerli sağlayıcı kimliği. */
  provider: string;
  /** Bu ürün için tek geçerli piyasa kimliği. */
  market: string;
  /** Bu kaynağın kendi bayatlama süresi (ms). */
  staleAfterMs: number;
  /**
   * Fiyat, aynı kategorideki başka bir üründen ORTAK KATEGORİ FİYATI olarak
   * alındıysa o ürünün kimliği. Kaynak yeni/eski ayrımı yayımlamadığında
   * kullanılır ve arayüzde açıkça belirtilir.
   */
  sharedFrom?: string;
}

export interface PriceSnapshot {
  provider: PriceProviderMeta;
  /** productId -> fiyat. Fiyatı olmayan ürün burada BULUNMAZ. */
  quotes: Record<string, PriceQuote>;
  fetchedAt: string;
  /** ok = istenen tüm fiyatlar geldi, partial = bir kısmı, unavailable = hiçbiri. */
  status: "ok" | "partial" | "unavailable";
  /** Sağlayıcı hata verdiyse kullanıcıya gösterilecek Türkçe mesaj. */
  error: string | null;
}

export interface PriceProvider {
  readonly meta: PriceProviderMeta;
  getQuotes(productIds: readonly string[]): Promise<PriceSnapshot>;
}

/**
 * Anlık görüntünün bayatlayıp bayatlamadığını söyler. Bayat veri "güncel" diye sunulmaz.
 * true: zaman geçersiz, sağlayıcı tazelik süresi aşılmış veya zaman toleransın ötesinde gelecekte.
 */
export function isSnapshotStale(snapshot: PriceSnapshot, now: number = Date.now()): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return true;
  if (fetchedAt - now > SNAPSHOT_FUTURE_TOLERANCE_MS) return true;
  return now - fetchedAt > snapshot.provider.staleAfterMs;
}

export function emptySnapshot(meta: PriceProviderMeta, error: string): PriceSnapshot {
  return {
    provider: meta,
    quotes: {},
    fetchedAt: new Date().toISOString(),
    status: "unavailable",
    error,
  };
}
