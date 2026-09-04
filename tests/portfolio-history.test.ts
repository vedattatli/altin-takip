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
 * Grafiğin tek işi GERÇEKTE ÖLÇÜLMÜŞ fiyatları çizmektir. Bu testler uydurma
 * çözünürlük üretilmediğini ve geçmişin çarpıtılmadığını sabitler.
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
    const series = await history.series(userActor(user), "24h");
    expect(series.empty).toBe(true);
    expect(series.points).toEqual([]);
  });

  it("nokta sayısı gözlem sayısı kadardır; ara noktalar üretilmez", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "2", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-10T10:00:00.000Z", "yeni-ceyrek", "11000");
    writeHistory(backend, "2026-03-10T10:10:00.000Z", "yeni-ceyrek", "11100");
    writeHistory(backend, "2026-03-10T10:20:00.000Z", "yeni-ceyrek", "11050");

    const series = await history.series(userActor(user), "24h");
    expect(series.points).toHaveLength(3);
    // 2 adet × fiyat — türetme, yuvarlama, düzleştirme yok.
    expect(series.points.map((point) => point.liquidationValue)).toEqual(["22000.00", "22200.00", "22100.00"]);
    // Gözlemler 10 dakika arayla: kullanıcıya bildirilen sıklık da bu olmalı.
    expect(series.medianStepMs).toBe(600_000);
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

    const series = await history.series(userActor(user), "24h");
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

    const series = await history.series(userActor(user), "24h");
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

    const series = await history.series(userActor(user), "24h");
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

    const series = await history.series(userActor(user), "24h");
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.at).toBe("2026-03-10T08:00:00.000Z");
  });

  it("aralık dışındaki gözlemler seriye girmez", async () => {
    await portfolio.appendTransaction(
      userActor(user),
      buyCommand({ productId: "yeni-ceyrek", occurredAt: "2026-03-01", quantity: "1", unitPrice: "10000" }),
    );
    writeHistory(backend, "2026-03-09T12:00:00.000Z", "yeni-ceyrek", "10000");
    writeHistory(backend, "2026-03-10T11:30:00.000Z", "yeni-ceyrek", "11000");

    const series = await history.series(userActor(user), "1h");
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.liquidationValue).toBe("11000.00");
  });
});
