import { beforeAll, describe, expect, it } from "vitest";

import { availableQuantity, buildPortfolio, EMPTY_SUMMARY } from "@/domain/portfolio";
import type { PriceSnapshot } from "@/prices/types";
import { fixedSnapshot, makeTransaction } from "./helpers";

let snapshot: PriceSnapshot;

beforeAll(async () => {
  snapshot = await fixedSnapshot();
});

describe("boş portföy", () => {
  it("yeni hesap tamamen sıfır değerlerle açılır", () => {
    const summary = buildPortfolio([], snapshot);

    expect(summary).toEqual(EMPTY_SUMMARY);
    expect(summary.holdings).toHaveLength(0);
    expect(summary.positionCount).toBe(0);
    expect(summary.totalLiquidationValue).toBe(0);
    expect(summary.totalRepurchaseValue).toBe(0);
    expect(summary.totalCostBasis).toBe(0);
    expect(summary.totalUnrealizedPnL).toBe(0);
  });

  it("varsayılan örnek varlık (örn. 104 gram) eklenmez", () => {
    const summary = buildPortfolio([], snapshot);
    expect(summary.totalPureGoldGrams).toBe(0);
    expect(summary.holdings.some((holding) => holding.quantity > 0)).toBe(false);
  });
});

describe("alış işlemleri", () => {
  it("toplam maliyeti işçilik dâhil hesaplar", () => {
    const summary = buildPortfolio(
      [makeTransaction({ quantity: 10, unitPrice: 5000, feeAmount: 250 })],
      snapshot,
    );

    expect(summary.positionCount).toBe(1);
    expect(summary.totalCostBasis).toBe(50_250);
    expect(summary.holdings[0].quantity).toBe(10);
    expect(summary.holdings[0].averageUnitCost).toBe(5025);
  });

  it("aynı üründen ikinci alışta ortalama maliyeti günceller", () => {
    const summary = buildPortfolio(
      [
        makeTransaction({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
        makeTransaction({ tradedAt: "2026-01-20", quantity: 10, unitPrice: 6000 }),
      ],
      snapshot,
    );

    expect(summary.holdings[0].quantity).toBe(20);
    expect(summary.totalCostBasis).toBe(110_000);
    expect(summary.holdings[0].averageUnitCost).toBe(5500);
  });

  it("has altın karşılığını ürünün milyemine göre hesaplar", () => {
    const summary = buildPortfolio(
      [makeTransaction({ productId: "yeni-ceyrek", quantity: 4, unitPrice: 9000 })],
      snapshot,
    );

    // Yeni çeyrek: 1.75 gr brüt, 916 milyem -> 1.603 gr has
    expect(summary.totalPureGoldGrams).toBeCloseTo(4 * 1.603, 3);
  });
});

describe("fiyat yönü", () => {
  it("bozdurma değeri ALIŞ, yeniden alım değeri SATIŞ fiyatıyla hesaplanır", () => {
    const summary = buildPortfolio([makeTransaction({ quantity: 10, unitPrice: 5000 })], snapshot);
    const quote = snapshot.quotes["gram-altin"];

    expect(quote.buyPrice).toBeLessThan(quote.sellPrice);
    expect(summary.totalLiquidationValue).toBeCloseTo(10 * quote.buyPrice, 2);
    expect(summary.totalRepurchaseValue).toBeCloseTo(10 * quote.sellPrice, 2);
    // Bozdurma değeri her zaman yeniden alım değerinden küçüktür.
    expect(summary.totalLiquidationValue).toBeLessThan(summary.totalRepurchaseValue);
  });

  it("kâr/zarar bozdurma değeri ile maliyet farkıdır", () => {
    const summary = buildPortfolio([makeTransaction({ quantity: 10, unitPrice: 5000 })], snapshot);
    expect(summary.totalUnrealizedPnL).toBeCloseTo(
      summary.totalLiquidationValue - summary.totalCostBasis,
      2,
    );
  });

  it("fiyat kaydı yoksa değer 0 gösterilmez, null kalır", () => {
    const emptyPrices: PriceSnapshot = { ...snapshot, quotes: {}, status: "unavailable" };
    const summary = buildPortfolio([makeTransaction({ quantity: 5 })], emptyPrices);

    expect(summary.holdings[0].liquidationValue).toBeNull();
    expect(summary.holdings[0].unrealizedPnL).toBeNull();
    expect(summary.hasMissingPrices).toBe(true);
    expect(summary.unpricedCostBasis).toBe(25_000);
    expect(summary.totalLiquidationValue).toBe(0);
  });
});

describe("satış işlemleri", () => {
  it("kalan miktarı ve maliyeti düşürür", () => {
    const summary = buildPortfolio(
      [
        makeTransaction({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
        makeTransaction({ tradedAt: "2026-01-20", side: "sell", quantity: 4, unitPrice: 5500 }),
      ],
      snapshot,
    );

    expect(summary.holdings[0].quantity).toBe(6);
    expect(summary.totalCostBasis).toBe(30_000);
    // 4 x (5500 - 5000) = 2000 gerçekleşmiş kâr
    expect(summary.totalRealizedPnL).toBe(2000);
  });

  it("satışta işçilik gerçekleşmiş kârdan düşülür", () => {
    const summary = buildPortfolio(
      [
        makeTransaction({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
        makeTransaction({
          tradedAt: "2026-01-20",
          side: "sell",
          quantity: 4,
          unitPrice: 5500,
          feeAmount: 200,
        }),
      ],
      snapshot,
    );

    expect(summary.totalRealizedPnL).toBe(1800);
  });

  it("tamamı satıldığında pozisyon kapanır", () => {
    const summary = buildPortfolio(
      [
        makeTransaction({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
        makeTransaction({ tradedAt: "2026-01-20", side: "sell", quantity: 10, unitPrice: 5200 }),
      ],
      snapshot,
    );

    expect(summary.positionCount).toBe(0);
    expect(summary.totalCostBasis).toBe(0);
    expect(summary.totalLiquidationValue).toBe(0);
    expect(summary.totalRealizedPnL).toBe(2000);
  });
});

describe("kayıt silme", () => {
  it("işlem listeden çıkarılınca toplamlar yeniden hesaplanır", () => {
    const first = makeTransaction({ id: "a", quantity: 10, unitPrice: 5000 });
    const second = makeTransaction({ id: "b", quantity: 5, unitPrice: 6000 });

    const before = buildPortfolio([first, second], snapshot);
    expect(before.totalCostBasis).toBe(80_000);

    const after = buildPortfolio([first], snapshot);
    expect(after.totalCostBasis).toBe(50_000);
    expect(after.holdings[0].quantity).toBe(10);
  });

  it("tüm işlemler silinince portföy tekrar sıfırlanır", () => {
    expect(buildPortfolio([], snapshot)).toEqual(EMPTY_SUMMARY);
  });
});

describe("availableQuantity", () => {
  it("alış ve satışları netleştirir", () => {
    const transactions = [
      makeTransaction({ id: "a", tradedAt: "2026-01-10", quantity: 10 }),
      makeTransaction({ id: "b", tradedAt: "2026-01-15", side: "sell", quantity: 3 }),
    ];
    expect(availableQuantity(transactions, "gram-altin")).toBe(7);
  });

  it("düzenlenen kaydı hesaba katmaz", () => {
    const transactions = [
      makeTransaction({ id: "a", tradedAt: "2026-01-10", quantity: 10 }),
      makeTransaction({ id: "b", tradedAt: "2026-01-15", side: "sell", quantity: 3 }),
    ];
    expect(availableQuantity(transactions, "gram-altin", { excludeTransactionId: "b" })).toBe(10);
  });

  it("başka ürünün miktarını karıştırmaz", () => {
    const transactions = [
      makeTransaction({ id: "a", productId: "gram-altin", quantity: 10 }),
      makeTransaction({ id: "b", productId: "yeni-ceyrek", quantity: 2 }),
    ];
    expect(availableQuantity(transactions, "yeni-ceyrek")).toBe(2);
  });
});
