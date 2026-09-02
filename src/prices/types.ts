/**
 * Fiyat sağlayıcı sözleşmesi.
 *
 * TEMEL KURALLAR
 * 1. buyPrice ve sellPrice birbirine ÇEVRİLMEZ, türetilmez, yer değiştirmez.
 *    buyPrice  = piyasanın alış fiyatı  (kullanıcı bozdurursa eline geçen)
 *    sellPrice = piyasanın satış fiyatı (kullanıcı yeniden alırsa ödediği)
 * 2. Bir sağlayıcı başarısız olursa BAŞKA BİR PİYASANIN fiyatı sessizce
 *    gösterilmez. Sonuç "unavailable" döner ve arayüz bunu açıkça yazar.
 * 3. Test verisi hiçbir koşulda gerçek piyasa verisi gibi etiketlenmez.
 */

export type PriceStatus = "ok" | "stale" | "unavailable";

export interface PriceQuote {
  productId: string;
  /** Piyasanın alış fiyatı (TL). Kullanıcının bozdurma karşılığı. */
  buyPrice: number;
  /** Piyasanın satış fiyatı (TL). Kullanıcının yeniden alım maliyeti. */
  sellPrice: number;
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
   * false ise bu sağlayıcı GERÇEK piyasa verisi vermez.
   * Arayüz bu durumda mutlaka "Test Verisi" uyarısını göstermelidir.
   */
  isRealMarketData: boolean;
  /** Kullanıcıya gösterilecek kısa açıklama. */
  disclaimer: string;
  /** Verinin bayatlamış sayılacağı süre (ms). */
  staleAfterMs: number;
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

/** Anlık görüntünün bayatlayıp bayatlamadığını söyler. Bayat veri "güncel" diye sunulmaz. */
export function isSnapshotStale(snapshot: PriceSnapshot, now: number = Date.now()): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(fetchedAt)) return true;
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
