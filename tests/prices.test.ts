import { describe, expect, it } from "vitest";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import { MOCK_PROVIDER_META, MockPriceProvider } from "@/prices/mock-provider";
import { isSnapshotStale } from "@/prices/types";

const ALL_IDS = GOLD_PRODUCTS.map((product) => product.id);
const FIXED_TIME = Date.parse("2026-02-01T10:00:00Z");

function provider(options = {}) {
  return new MockPriceProvider({ now: () => FIXED_TIME, basePricePerPureGram: 5000, ...options });
}

describe("MockPriceProvider", () => {
  it("test verisi olduğunu açıkça bildirir", () => {
    expect(MOCK_PROVIDER_META.isRealMarketData).toBe(false);
    expect(MOCK_PROVIDER_META.label).toBe("Test Verisi");
    expect(MOCK_PROVIDER_META.market).toBe("TEST");
    expect(MOCK_PROVIDER_META.disclaimer).toMatch(/Gerçek piyasa fiyatı değildir/);
  });

  it("mock fiyatları gerçek piyasa verisi gibi etiketlemez", async () => {
    const snapshot = await provider().getQuotes(ALL_IDS);
    expect(snapshot.provider.isRealMarketData).toBe(false);
    for (const quote of Object.values(snapshot.quotes)) {
      expect(quote.provider).toBe("mock");
      expect(quote.market).toBe("TEST");
    }
  });

  it("her ürün için alış fiyatı satış fiyatından düşüktür", async () => {
    const snapshot = await provider().getQuotes(ALL_IDS);
    expect(Object.keys(snapshot.quotes)).toHaveLength(ALL_IDS.length);
    for (const quote of Object.values(snapshot.quotes)) {
      expect(quote.buyPrice).toBeGreaterThan(0);
      expect(quote.buyPrice).toBeLessThan(quote.sellPrice);
    }
  });

  it("alış ve satış birbirinden türetilmez; makas kategoriye göre değişir", async () => {
    const snapshot = await provider().getQuotes(["gram-altin", "bilezik-22-ayar"]);
    const gram = snapshot.quotes["gram-altin"];
    const bilezik = snapshot.quotes["bilezik-22-ayar"];

    const gramSpread = (gram.sellPrice - gram.buyPrice) / gram.sellPrice;
    const bilezikSpread = (bilezik.sellPrice - bilezik.buyPrice) / bilezik.sellPrice;
    expect(bilezikSpread).toBeGreaterThan(gramSpread);
  });

  it("fiyat ürünün has altın karşılığıyla orantılıdır", async () => {
    const snapshot = await provider().getQuotes(["gram-altin", "yeni-tam"]);
    const gram = snapshot.quotes["gram-altin"];
    const tam = snapshot.quotes["yeni-tam"];
    // Yeni tam 6.412 gr has içerir; fiyatı gram altından belirgin biçimde yüksektir.
    expect(tam.buyPrice).toBeGreaterThan(gram.buyPrice * 6);
  });

  it("aynı zaman diliminde deterministiktir", async () => {
    const first = await provider().getQuotes(ALL_IDS);
    const second = await provider().getQuotes(ALL_IDS);
    expect(second.quotes).toEqual(first.quotes);
  });

  it("zaman ilerleyince fiyatlar değişir", async () => {
    const later = new MockPriceProvider({
      now: () => FIXED_TIME + 10 * 60 * 1000,
      basePricePerPureGram: 5000,
    });
    const first = await provider().getQuotes(["gram-altin"]);
    const second = await later.getQuotes(["gram-altin"]);
    expect(second.quotes["gram-altin"].buyPrice).not.toBe(first.quotes["gram-altin"].buyPrice);
  });

  it("bilinmeyen ürün istendiğinde kısmi sonuç döner, uydurma fiyat üretmez", async () => {
    const snapshot = await provider().getQuotes(["gram-altin", "olmayan-urun"]);
    expect(snapshot.status).toBe("partial");
    expect(snapshot.quotes["olmayan-urun"]).toBeUndefined();
    expect(snapshot.error).toMatch(/değerlemeye dâhil edilmedi/);
  });

  it("sağlayıcı çalışmadığında başka piyasaya sessizce geçmez", async () => {
    const snapshot = await provider({ simulateOutage: true }).getQuotes(ALL_IDS);
    expect(snapshot.status).toBe("unavailable");
    expect(Object.keys(snapshot.quotes)).toHaveLength(0);
    expect(snapshot.provider.market).toBe("TEST");
    expect(snapshot.error).toMatch(/ulaşılamıyor/);
  });

  it("her fiyat kaydı gerekli tüm alanları içerir", async () => {
    const snapshot = await provider().getQuotes(["gram-altin"]);
    const quote = snapshot.quotes["gram-altin"];
    expect(Object.keys(quote).sort()).toEqual(
      [
        "buyPrice",
        "currency",
        "fetchedAt",
        "market",
        "productId",
        "provider",
        "providerTimestamp",
        "sellPrice",
        "status",
      ].sort(),
    );
    expect(quote.currency).toBe("TRY");
    expect(quote.status).toBe("ok");
  });
});

describe("bayat veri", () => {
  it("tazelik süresi geçen anlık görüntü güncel sayılmaz", async () => {
    const snapshot = await provider().getQuotes(["gram-altin"]);
    expect(isSnapshotStale(snapshot, FIXED_TIME + 60_000)).toBe(false);
    expect(isSnapshotStale(snapshot, FIXED_TIME + 10 * 60_000)).toBe(true);
  });
});
