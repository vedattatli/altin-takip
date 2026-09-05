import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { PortfolioHistoryService } from "@/server/portfolio/portfolio-history-service";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { userActor } from "./actors";
import { buyCommand } from "./helpers";

/**
 * PORTFÖY DEĞERİ GRAFİĞİ — SERİ ÜRETİMİ
 *
 * Aralık, "son şu kadar süre" DEĞİL, grafiğin KIRILIM adımıdır (borsa
 * arayüzlerindeki 15m / 1H / 4H / 1D / 1W ile aynı anlam). Bu testler hem
 * kovalamanın doğru çalıştığını hem de uydurma çözünürlük üretilmediğini
 * sabitler.
 */

let backend: LocalAuthBackend;
let portfolio: UserPortfolioService;
let history: PortfolioHistoryService;
let user: UserProfile;

const NOW = Date.parse("2026-03-10T12:00:00.000Z");

/** Geçmişe fiyat noktası yazar (üretimdeki price_quote_history ikizi). */
function writeHistory(store: LocalAuthBackend, at: string, productId: string, liquidation: string): void {
  const internal = store as unknown as {
    store: { priceQuoteHistory: Record<string, unknown>[] };
  };
  internal.store.priceQuoteHistory.push({
    providerCode: "sarraf-tv-kayseri-screen",
    canonicalProductId: productId,
    marketId: "kayseri",
    liquidationPrice: liquidation,
    replacementPrice: liquidation,
    currency: "TRY",
    upstreamSourceId: "sarraf-tv-screen",
    providerTimestamp: "",
    fetchedAt: at,
    status: "ok",
    mappingVersion: "test",
    rawPayloadHash: null,
    ingestionRunId: null,
  });
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  portfolio = new UserPortfolioService(backend);
  history = new PortfolioHistoryService(backend, { now: () => NOW });
  user = await backend.createUser({
    username: "grafik",
    displayName: "Grafik Kullanıcı",
    temporaryPassword: "Kuyumcu7Defter",
    role: "user",
  });
});

describe("portföy değeri serisi", () => {
  it("fiyat geçmişi yoksa boş döner; sıfır çizgisi UYDURULMAZ", async () => {
    const series = await history.series(userActor(user), "1h");
    expect(series.empty).toBe(true);
    expect(series.points).toEqual([]);
  });

  /*
   * ARALIK İÇİNDEKİ ALIM "KÂR" DEĞİLDİR.
   *
   * Grafik portföy DEĞERİNİ çizer. Kullanıcı aralık içinde altın aldıysa değer
   * fiyat hiç değişmese bile yükselir. Arayüz bunu bilmezse ilk-son farkını
   * yeşil bir yüzdeyle "kazanç" gibi gösterir; 50.000 TL'lik bir alım
   * "+%500 kâr" diye okunurdu.
   */
  it("aralıkta işlem yapıldıysa bildirilir", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-10T10:00:00.000Z", "yeni-ceyrek", "11000");
    writeHistory(backend, "2026-03-10T11:00:00.000Z", "yeni-ceyrek", "11000");

    // Önce: aralıkta işlem yok, fark yalnızca fiyat hareketidir.
    const before = await history.series(userActor(user), "1h");
    expect(before.ledgerChangesInRange).toBe(0);

    // Sonra: iki gözlem ARASINDA alım yapılır. Fiyat aynı kalsa da değer artar.
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({
        productId: "yeni-ceyrek",
        occurredAt: "2026-03-10",
        occurredTime: "13:30",
        quantity: "4",
        unitPrice: "10000",
      }),
    );

    const after = await history.series(userActor(user), "1h");
    expect(after.ledgerChangesInRange).toBe(1);
    // Değer 11.000 → 55.000: sıçrama fiyattan değil, eklenen altından geliyor.
    expect(after.points.map((point) => point.liquidationValue)).toEqual(["11000.00", "55000.00"]);
  });

  /*
   * ARALIK = KIRILIM ADIMI.
   *
   * Aynı gözlem kümesi, seçilen adıma göre farklı sayıda noktaya iner. Kovanın
   * değeri o kovaya düşen SON gözlemdir (mum kapanışı); daha eski gözlemler
   * çizilmez ama sayılır.
   */
  it("gözlemler seçilen adıma göre kovalanır; kova değeri son gözlemdir", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "2", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-10T10:00:00.000Z", "yeni-ceyrek", "11000");
    writeHistory(backend, "2026-03-10T10:10:00.000Z", "yeni-ceyrek", "11100");
    writeHistory(backend, "2026-03-10T10:20:00.000Z", "yeni-ceyrek", "11050");

    // 15 dakikalık: 10:00 ve 10:10 aynı kovada (kapanış 11100), 10:20 ayrı kovada.
    const quarter = await history.series(userActor(user), "15m");
    expect(quarter.points).toHaveLength(2);
    expect(quarter.points.map((point) => point.liquidationValue)).toEqual(["22200.00", "22100.00"]);
    expect(quarter.points.map((point) => point.observations)).toEqual([2, 1]);
    // Nokta, kovanın BAŞLANGICIYLA etiketlenir; değer ise gerçek gözlem anından.
    expect(quarter.points[0]?.at).toBe("2026-03-10T10:00:00.000Z");
    expect(quarter.points[0]?.observedAt).toBe("2026-03-10T10:10:00.000Z");

    // Saatlik: üçü de tek kovada, kapanış 11050.
    const hourly = await history.series(userActor(user), "1h");
    expect(hourly.points).toHaveLength(1);
    expect(hourly.points[0]?.liquidationValue).toBe("22100.00");
    expect(hourly.points[0]?.observations).toBe(3);

    // Bildirilen sıklık HAM gözlemlerden ölçülür, kovalardan değil.
    expect(hourly.medianStepMs).toBe(600_000);
  });

  /*
   * BOŞ KOVA DOLDURULMAZ.
   *
   * Toplayıcı gecikince bir kovaya hiç gözlem düşmez. O kovayı bir öncekinin
   * değeriyle doldurmak, olmayan bir ölçümü varmış gibi göstermek olurdu.
   * Çizgide boşluk kalır ve kaç kovanın boş olduğu bildirilir.
   */
  it("gözlem düşmeyen kova doldurulmaz, sayılır", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-10T10:00:00.000Z", "yeni-ceyrek", "11000");
    // Araya 10:15 ve 10:30 kovaları giriyor ama gözlem yok.
    writeHistory(backend, "2026-03-10T10:45:00.000Z", "yeni-ceyrek", "11500");

    const series = await history.series(userActor(user), "15m");
    expect(series.points).toHaveLength(2);
    expect(series.emptyIntervals).toBe(2);
  });

  /*
   * "Bugünkü portföyü geçmiş fiyatlarla çarpmak" kolay ama YANLIŞ olurdu:
   * henüz alınmamış altını geçmiş noktalarda göstermek geçmişi çarpıtır.
   */
  it("her nokta O ANA KADARKİ deftere göre hesaplanır", async () => {
    writeHistory(backend, "2026-03-10T09:00:00.000Z", "yeni-ceyrek", "11000");
    writeHistory(backend, "2026-03-10T11:00:00.000Z", "yeni-ceyrek", "11000");
    // Alış iki gözlemin ARASINDA yapıldı.
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({
        productId: "yeni-ceyrek",
        occurredAt: "2026-03-10",
        occurredTime: "13:00",
        quantity: "3",
        unitPrice: "10000",
      }),
    );

    const series = await history.series(userActor(user), "1h");
    expect(series.points).toHaveLength(2);
    // İlk noktada elde altın YOKTU.
    expect(series.points[0]?.liquidationValue).toBe("0.00");
    expect(series.points[1]?.liquidationValue).toBe("33000.00");
  });

  it("fiyatı olmayan ürün toplama katılmaz ve nokta kısmi işaretlenir", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "gremse-altin", occurredAt: "2026-03-01", quantity: "1", unitPrice: "100000" }),
    );
    // Yalnızca çeyreğin fiyatı var.
    writeHistory(backend, "2026-03-10T10:00:00.000Z", "yeni-ceyrek", "11000");

    const series = await history.series(userActor(user), "1h");
    expect(series.points).toHaveLength(1);
    // Gremse SIFIR sayılmadı, toplamın dışında bırakıldı.
    expect(series.points[0]?.liquidationValue).toBe("11000.00");
    expect(series.points[0]?.pricedProducts).toBe(1);
    expect(series.points[0]?.missingProducts).toBe(1);
  });

  /*
   * Kaynak susunca son fiyatı sonsuza kadar uzatmak, bayat veriyi güncel
   * göstermektir. Taşıma sınırı aşıldığında ürün fiyatsız sayılır.
   */
  it("çok eski fiyat ileriye taşınmaz", async () => {
    for (const productId of ["yeni-ceyrek", "gremse-altin"]) {
      await portfolio.appendTransaction(
        userActor(user),
        buyCommand({ productId, occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
      );
    }
    // Çeyreğin fiyatı 4 saat önce (taşıma sınırı 3 saat); gremse taze.
    writeHistory(backend, "2026-03-10T08:00:00.000Z", "yeni-ceyrek", "11000");
    writeHistory(backend, "2026-03-10T11:59:00.000Z", "gremse-altin", "100000");

    const series = await history.series(userActor(user), "1h");
    const last = series.points[series.points.length - 1];
    // Son noktada çeyreğin fiyatı artık kullanılamaz: sabit çizgi olarak uzatılmaz.
    expect(last?.missingProducts).toBe(1);
    expect(last?.liquidationValue).toBe("100000.00");
  });

  /*
   * Elde ürün varken HİÇBİRİNİN fiyatı yoksa nokta ÜRETİLMEZ. "0 TL" yazmak,
   * portföyün değersizleştiğini söylemek olurdu; oysa bilinmeyen tek şey fiyat.
   */
  it("elde ürün varken hiç fiyat yoksa o an için nokta üretilmez", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-10T08:00:00.000Z", "yeni-ceyrek", "11000");
    // 4 saat sonraki gözlem: çeyreğin fiyatı taşınamaz, başka ürün de yok.
    writeHistory(backend, "2026-03-10T11:59:00.000Z", "yeni-yarim", "22000");

    const series = await history.series(userActor(user), "1h");
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.at).toBe("2026-03-10T08:00:00.000Z");
  });

  /*
   * GERİYE BAKIŞ ARALIKTAN TÜRETİLİR: aralık × en fazla nokta. Borsa arayüzü de
   * ekranda sabit sayıda mum tutar; ayrı bir "şu kadar gün" tablosu uydurulmaz.
   * 15 dakikalık adımda ~5 gün, günlük adımda ~500 gün geriye gidilir.
   */
  it("geriye bakış aralıktan türetilir; adım büyüdükçe geçmiş açılır", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    // Altı gün önce: 15 dakikalık pencerenin (~5 gün) DIŞINDA.
    writeHistory(backend, "2026-03-04T12:00:00.000Z", "yeni-ceyrek", "10000");
    writeHistory(backend, "2026-03-10T11:30:00.000Z", "yeni-ceyrek", "11000");

    const quarter = await history.series(userActor(user), "15m");
    expect(quarter.points).toHaveLength(1);
    expect(quarter.points[0]?.liquidationValue).toBe("11000.00");

    // Günlük adımda pencere ~500 güne çıkar; eski gözlem de görünür.
    const daily = await history.series(userActor(user), "1d");
    expect(daily.points).toHaveLength(2);
    expect(daily.points.map((point) => point.liquidationValue)).toEqual(["10000.00", "11000.00"]);
  });
});
