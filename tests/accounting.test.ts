import { describe, expect, it } from "vitest";

import {
  availableQuantityFor,
  buildAccountingSummary,
  costQualityOf,
  dec,
  EMPTY_SUMMARY,
  findLedgerOversell,
  LedgerOversellError,
  replayLedger,
  replayProduct,
  resolveLedgerAmounts,
  toDecimalString,
  type LedgerEntry,
} from "@/domain/accounting";
import { makeEntry, snapshotWith } from "./helpers";

/**
 * MUHASEBE MOTORU — KESİN KABUL TESTLERİ (docs/ACCOUNTING_MODEL.md örnekleri)
 * Bütün değerler ondalık dize; kayan nokta artığı hiçbir sonuçta görünmez.
 */

const NOW = Date.parse("2026-03-01T10:00:00Z");
const nowIso = new Date(NOW).toISOString();

function summaryOf(entries: LedgerEntry[], prices: Record<string, { liquidation: string; replacement: string }>) {
  return buildAccountingSummary(entries, snapshotWith(prices, { fetchedAt: nowIso }), NOW);
}

describe("boş portföy", () => {
  it("yeni hesap tamamen sıfır değerlerle açılır; örnek varlık eklenmez", () => {
    const summary = buildAccountingSummary([], null, NOW);
    expect(summary.holdings).toHaveLength(0);
    expect(summary.positionCount).toBe(0);
    expect(summary.totalLiquidationValue).toBe("0");
    expect(summary.totalReplacementValue).toBe("0");
    expect(summary.totalRemainingCostBasis).toBe("0");
    expect(summary.totalUnrealizedPnl).toBe("0");
    expect(summary.totalRealizedPnl).toBe("0");
    expect(summary.totalPnl).toBe("0");
    expect(summary.totalPureGoldGrams).toBe("0");
    expect(summary.pnlLabel).toBe("COST_BASIS");
    expect({ ...summary, snapshot: null, priceStatus: "unavailable" }).toEqual(EMPTY_SUMMARY);
  });
});

describe("ÖRNEK 1 — ağırlıklı ortalama", () => {
  const entries = [
    makeEntry({ occurredAt: "2026-01-10", quantity: "5", unitPrice: "3500" }),
    makeEntry({ occurredAt: "2026-01-11", quantity: "5", unitPrice: "4200" }),
    makeEntry({ occurredAt: "2026-01-12", quantity: "5", unitPrice: "3700" }),
  ];

  it("miktar 15, toplam maliyet 57.000, ortalama 3.800", () => {
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("15");
    expect(position.remainingCostBasis).toBe("57000");
    expect(position.averageCost).toBe("3800");
    expect(position.realizedPnl).toBe("0");
  });

  it("liquidation 4.100 ise değer 61.500 ve gerçekleşmemiş K/Z +4.500", () => {
    const summary = summaryOf(entries, { "gram-altin": { liquidation: "4100", replacement: "4200" } });
    const holding = summary.holdings[0]!;
    expect(holding.liquidationValue).toBe("61500");
    expect(holding.replacementValue).toBe("63000");
    expect(holding.unrealizedPnl).toBe("4500");
    expect(summary.totalLiquidationValue).toBe("61500");
    expect(summary.totalUnrealizedPnl).toBe("4500");
    expect(summary.totalPnl).toBe("4500");
    expect(holding.costQuality).toBe("ACTUAL");
    expect(summary.pnlLabel).toBe("COST_BASIS");
  });
});

describe("ÖRNEK 2 — market baseline + yeni alış", () => {
  const opening = makeEntry({
    kind: "OPENING_BALANCE",
    pricingInputMode: "MARKET_BASELINE",
    occurredAt: "2026-01-10",
    quantity: "100",
    unitPrice: "5000",
  });

  it("açılış maliyet bazı 500.000 ve ilk anda gerçekleşmemiş K/Z tam sıfır", () => {
    expect(opening.totalPaid).toBe("500000");
    expect(opening.costBasisOrigin).toBe("MARKET_BASELINE");
    const summary = summaryOf([opening], { "gram-altin": { liquidation: "5000", replacement: "5100" } });
    expect(summary.holdings[0]!.unrealizedPnl).toBe("0");
    expect(summary.holdings[0]!.costQuality).toBe("BASELINE");
    expect(summary.pnlLabel).toBe("SINCE_TRACKING_START");
  });

  it("5 gram × 5.200 alış sonrası 105 gram, 526.000 TL, ortalama 5.009,523809...", () => {
    const entries = [opening, makeEntry({ occurredAt: "2026-01-20", quantity: "5", unitPrice: "5200" })];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("105");
    expect(position.remainingCostBasis).toBe("526000");
    expect(position.averageCost).toBe("5009.52380952");
    expect(dec(position.averageCost!).toFixed(6)).toBe("5009.523810");

    const summary = summaryOf(entries, { "gram-altin": { liquidation: "5300", replacement: "5400" } });
    const holding = summary.holdings[0]!;
    expect(holding.liquidationValue).toBe("556500");
    expect(holding.unrealizedPnl).toBe("30500");
    expect(holding.costQuality).toBe("MIXED");
    expect(summary.hasEstimatedOrBaseline).toBe(true);
    expect(summary.pnlLabel).toBe("SINCE_TRACKING_START");
  });
});

describe("ÖRNEK 3 — çeyrek altın (adet)", () => {
  const entries = [
    makeEntry({ productId: "yeni-ceyrek", occurredAt: "2026-01-10", quantity: "10", unitPrice: "11000" }),
    makeEntry({ productId: "yeni-ceyrek", occurredAt: "2026-01-11", quantity: "2", unitPrice: "11200" }),
    makeEntry({ productId: "yeni-ceyrek", occurredAt: "2026-01-12", quantity: "1", unitPrice: "10900" }),
    makeEntry({ productId: "yeni-ceyrek", occurredAt: "2026-01-13", quantity: "1", unitPrice: "11300" }),
  ];

  it("14 adet, 154.600 TL, ortalama 11.042,857142...", () => {
    const position = replayProduct(entries, "yeni-ceyrek");
    expect(position.quantity).toBe("14");
    expect(position.remainingCostBasis).toBe("154600");
    expect(position.averageCost).toBe("11042.85714286");
  });

  it("liquidation 11.300 ise değer 158.200 ve gerçekleşmemiş K/Z 3.600", () => {
    const summary = summaryOf(entries, { "yeni-ceyrek": { liquidation: "11300", replacement: "11500" } });
    expect(summary.holdings[0]!.liquidationValue).toBe("158200");
    expect(summary.holdings[0]!.unrealizedPnl).toBe("3600");
  });
});

describe("ÖRNEK 4 — satış", () => {
  const entries = [
    makeEntry({ occurredAt: "2026-01-10", quantity: "5", unitPrice: "3500" }),
    makeEntry({ occurredAt: "2026-01-11", quantity: "5", unitPrice: "4200" }),
    makeEntry({ occurredAt: "2026-01-12", quantity: "5", unitPrice: "3700" }),
    makeEntry({ kind: "SELL", occurredAt: "2026-02-01", quantity: "4", unitPrice: "4200" }),
  ];

  it("net gelir 16.800, çıkarılan maliyet 15.200, gerçekleşmiş K/Z 1.600", () => {
    const sale = entries[3]!;
    expect(sale.netProceeds).toBe("16800");
    const position = replayProduct(entries, "gram-altin");
    expect(position.realizedPnl).toBe("1600");
    expect(position.quantity).toBe("11");
    expect(position.remainingCostBasis).toBe("41800");
    // Satış ortalamayı DEĞİŞTİRMEZ.
    expect(position.averageCost).toBe("3800");
  });

  it("liquidation 4.100 ise gerçekleşmemiş 3.300 ve toplam K/Z 4.900", () => {
    const summary = summaryOf(entries, { "gram-altin": { liquidation: "4100", replacement: "4200" } });
    expect(summary.holdings[0]!.unrealizedPnl).toBe("3300");
    expect(summary.totalRealizedPnl).toBe("1600");
    expect(summary.totalUnrealizedPnl).toBe("3300");
    expect(summary.totalPnl).toBe("4900");
    // Satış geliri nakit varlık olarak portföy değerine EKLENMEZ.
    expect(summary.totalLiquidationValue).toBe("45100");
  });
});

describe("ÖRNEK 5 — masraflar", () => {
  it("10 gram × 5.000 + işçilik 500 + komisyon 100 = 50.600, ortalama 5.060", () => {
    const entry = makeEntry({ quantity: "10", unitPrice: "5000", workmanship: "500", fees: "100" });
    expect(entry.grossAmount).toBe("50000");
    expect(entry.totalPaid).toBe("50600");
    const position = replayProduct([entry], "gram-altin");
    expect(position.remainingCostBasis).toBe("50600");
    expect(position.averageCost).toBe("5060");
  });
});

describe("ÖRNEK 6 — toplam ödenen modu", () => {
  it("10 gram için 51.200 toplam: maliyet 51.200, ortalama 5.120; işçilik ikinci kez eklenmez", () => {
    const entry = makeEntry({
      quantity: "10",
      pricingInputMode: "TOTAL_AMOUNT",
      totalAmount: "51200",
      workmanship: "300",
      fees: "50",
    });
    expect(entry.totalPaid).toBe("51200");
    // Bilgi amaçlı ayrıştırma: brüt = toplam − işçilik − masraf.
    expect(entry.grossAmount).toBe("50850");
    const position = replayProduct([entry], "gram-altin");
    expect(position.remainingCostBasis).toBe("51200");
    expect(position.averageCost).toBe("5120");
  });

  it("masraflar toplam ödenen tutarı aşamaz", () => {
    expect(() =>
      resolveLedgerAmounts({
        kind: "BUY",
        quantity: "1",
        pricingInputMode: "TOTAL_AMOUNT",
        unitPrice: null,
        totalAmount: "100",
        fees: "60",
        workmanship: "50",
        baselineSnapshot: null,
      }),
    ).toThrow(/aşamaz/);
  });
});

describe("ÖRNEK 9 — geçmiş tarihli değişiklik", () => {
  it("geçmiş alış iptal edilince sonraki satış negatife düşerse oversell yakalanır; defter değişmez", () => {
    const entries = [
      makeEntry({ id: "buy-1", occurredAt: "2026-01-10", quantity: "10", unitPrice: "5000" }),
      makeEntry({ id: "sell-1", kind: "SELL", occurredAt: "2026-01-20", quantity: "7", unitPrice: "5200" }),
    ];
    expect(findLedgerOversell(entries)).toBeNull();

    const voided = entries.map((entry) =>
      entry.id === "buy-1" ? { ...entry, status: "VOID" as const, voidedAt: nowIso, voidReason: "test" } : entry,
    );
    const problem = findLedgerOversell(voided);
    expect(problem).toBeInstanceOf(LedgerOversellError);
    expect(problem?.entryId).toBe("sell-1");
    expect(problem?.available).toBe("0");
    expect(problem?.requested).toBe("7");
  });

  it("satış alıştan önceki tarihe konursa reddedilir", () => {
    const entries = [
      makeEntry({ occurredAt: "2026-01-20", quantity: "10", unitPrice: "5000" }),
      makeEntry({ kind: "SELL", occurredAt: "2026-01-10", quantity: "1", unitPrice: "5200" }),
    ];
    expect(() => replayProduct(entries, "gram-altin")).toThrow(LedgerOversellError);
  });
});

describe("ÖRNEK 10 — decimal hassasiyeti", () => {
  it("0,1 + 0,2 gram = 0,3 gram; ikili kayan nokta artığı oluşmaz", () => {
    const entries = [
      makeEntry({ occurredAt: "2026-01-10", quantity: "0.1", unitPrice: "5000.33", fees: "0.01" }),
      makeEntry({ occurredAt: "2026-01-11", quantity: "0.2", unitPrice: "5000.33", fees: "0.02" }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("0.3");
    expect(position.quantity).not.toContain("0000000000");
    // 0.1×5000.33 + 0.01 + 0.2×5000.33 + 0.02 = 500.033 + 1000.066 + 0.03 = 1500.129
    expect(position.remainingCostBasis).toBe("1500.129");
    expect(position.averageCost).toBe("5000.43");

    const summary = summaryOf(entries, { "gram-altin": { liquidation: "5100.10", replacement: "5200.20" } });
    expect(summary.holdings[0]!.liquidationValue).toBe("1530.03");
    expect(JSON.stringify(summary)).not.toMatch(/\d\.\d*0000000\d+|e[+-]\d/);
  });

  it("gram miktarında 6 ondalık desteklenir", () => {
    const entries = [
      makeEntry({ occurredAt: "2026-01-10", quantity: "1.000001", unitPrice: "1000" }),
      makeEntry({ occurredAt: "2026-01-11", quantity: "2.000002", unitPrice: "1000" }),
    ];
    expect(replayProduct(entries, "gram-altin").quantity).toBe("3.000003");
  });
});

describe("pozisyon kuralları", () => {
  it("pozisyon tamamen satılınca miktar 0, kalan maliyet 0, ortalama null; ondalık artık yok", () => {
    const entries = [
      makeEntry({ occurredAt: "2026-01-10", quantity: "3", unitPrice: "3333.33" }),
      makeEntry({ occurredAt: "2026-01-11", quantity: "7", unitPrice: "3456.78" }),
      makeEntry({ kind: "SELL", occurredAt: "2026-01-12", quantity: "3.3", unitPrice: "4000" }),
      makeEntry({ kind: "SELL", occurredAt: "2026-01-13", quantity: "6.7", unitPrice: "4000" }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("0");
    expect(position.remainingCostBasis).toBe("0");
    expect(position.averageCost).toBeNull();
    // Gerçekleşmiş K/Z = toplam net gelir − toplam maliyet
    expect(position.realizedPnl).toBe(toDecimalString(dec("40000").minus(dec("9999.99").plus(dec("24197.46")))));
  });

  it("farklı ürünlerin maliyetleri karışmaz", () => {
    const entries = [
      makeEntry({ productId: "gram-altin", quantity: "10", unitPrice: "5000" }),
      makeEntry({ productId: "yeni-ceyrek", quantity: "2", unitPrice: "11000" }),
      makeEntry({ productId: "has-altin", quantity: "1", unitPrice: "5500" }),
    ];
    const positions = replayLedger(entries);
    expect(positions.get("gram-altin")?.remainingCostBasis).toBe("50000");
    expect(positions.get("yeni-ceyrek")?.remainingCostBasis).toBe("22000");
    expect(positions.get("has-altin")?.remainingCostBasis).toBe("5500");
    expect(positions.get("gram-altin")?.averageCost).toBe("5000");
    expect(positions.get("yeni-ceyrek")?.averageCost).toBe("11000");
  });

  it("VOID ve REPLACED kayıtlar pozisyona girmez", () => {
    const entries = [
      makeEntry({ quantity: "10", unitPrice: "5000" }),
      makeEntry({ quantity: "5", unitPrice: "6000", status: "VOID", voidedAt: nowIso }),
      makeEntry({ quantity: "5", unitPrice: "7000", status: "REPLACED", voidedAt: nowIso }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("10");
    expect(position.activeTransactionCount).toBe(1);
  });

  it("maliyet kalitesi etiketleri", () => {
    expect(costQualityOf({ actual: true, estimated: false, baseline: false }, "1")).toBe("ACTUAL");
    expect(costQualityOf({ actual: false, estimated: true, baseline: false }, "1")).toBe("ESTIMATED");
    expect(costQualityOf({ actual: false, estimated: false, baseline: true }, "1")).toBe("BASELINE");
    expect(costQualityOf({ actual: true, estimated: false, baseline: true }, "1")).toBe("MIXED");
    expect(costQualityOf({ actual: true, estimated: false, baseline: false }, "0")).toBe("NONE");
  });

  it("satılabilir miktar", () => {
    const entries = [
      makeEntry({ id: "a", occurredAt: "2026-01-10", quantity: "10", unitPrice: "5000" }),
      makeEntry({ id: "b", kind: "SELL", occurredAt: "2026-01-11", quantity: "4", unitPrice: "5000" }),
    ];
    expect(availableQuantityFor(entries, "gram-altin")).toBe("6");
    expect(availableQuantityFor(entries, "gram-altin", { excludeEntryId: "b" })).toBe("10");
    expect(availableQuantityFor(entries, "yeni-ceyrek")).toBe("0");
  });
});

describe("değerleme — fiyat durumu", () => {
  const entries = [makeEntry({ quantity: "10", unitPrice: "5000" })];

  it("fiyat yoksa değerleme null'dır, sıfır değil", () => {
    const summary = buildAccountingSummary(entries, null, NOW);
    expect(summary.holdings[0]!.liquidationValue).toBeNull();
    expect(summary.holdings[0]!.unrealizedPnl).toBeNull();
    expect(summary.hasMissingPrices).toBe(true);
    expect(summary.priceStatus).toBe("unavailable");
    expect(summary.totalRemainingCostBasis).toBe("50000");
  });

  it("bayat fiyatla değerleme hesaplanmış gibi gösterilmez", () => {
    const stale = snapshotWith(
      { "gram-altin": { liquidation: "5100", replacement: "5200" } },
      { fetchedAt: new Date(NOW - 60 * 60 * 1000).toISOString() },
    );
    const summary = buildAccountingSummary(entries, stale, NOW);
    expect(summary.priceStatus).toBe("stale");
    expect(summary.holdings[0]!.liquidationValue).toBeNull();
  });

  it("başka ürünün fiyatından sessiz tahmin yapılmaz", () => {
    const summary = summaryOf(entries, { "has-altin": { liquidation: "5100", replacement: "5200" } });
    expect(summary.holdings[0]!.liquidationValue).toBeNull();
    expect(summary.unpricedCostBasis).toBe("50000");
  });

  it("bozdurma değeri liquidation, yeniden alım replacement fiyatıyla hesaplanır", () => {
    const summary = summaryOf(entries, { "gram-altin": { liquidation: "4900", replacement: "5150" } });
    expect(summary.holdings[0]!.liquidationValue).toBe("49000");
    expect(summary.holdings[0]!.replacementValue).toBe("51500");
    expect(summary.holdings[0]!.unrealizedPnl).toBe("-1000");
    expect(summary.holdings[0]!.unrealizedPnlPercent).toBe("-2");
  });
});

// --------------------------------------------------------------- özellik testleri

/** Deterministik PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLedger(seed: number): LedgerEntry[] {
  const random = rng(seed);
  const entries: LedgerEntry[] = [];
  let held = dec(0);
  for (let index = 0; index < 12; index += 1) {
    const day = String(10 + index).padStart(2, "0");
    const occurredAt = `2026-01-${day}`;
    const sell = held.greaterThan(0) && random() < 0.4;
    if (sell) {
      const fraction = dec(Math.floor(random() * 1000) + 1).div(1000);
      let quantity = held.times(fraction).toDecimalPlaces(6);
      if (quantity.isZero()) quantity = held;
      entries.push(
        makeEntry({
          kind: "SELL",
          occurredAt,
          quantity: toDecimalString(quantity),
          unitPrice: (4000 + Math.floor(random() * 2000)).toString(),
          // Masraf brüt tutarı aşamaz; küçük miktarlarda masrafsız satış.
          fees: quantity.greaterThan(1) ? String(Math.floor(random() * 50)) : "0",
        }),
      );
      held = held.minus(quantity);
    } else {
      const quantity = dec(Math.floor(random() * 10000) + 1).div(1000);
      entries.push(
        makeEntry({
          occurredAt,
          quantity: toDecimalString(quantity),
          unitPrice: (3000 + Math.floor(random() * 3000)).toString(),
          fees: String(Math.floor(random() * 100)),
        }),
      );
      held = held.plus(quantity);
    }
  }
  return entries;
}

describe("özellik testleri (deterministik rastgele defterler)", () => {
  const seeds = Array.from({ length: 40 }, (_, index) => index + 1);

  it("miktar hiçbir zaman negatif olmaz; sıfır miktarda kalan maliyet sıfırdır", () => {
    for (const seed of seeds) {
      const position = replayProduct(randomLedger(seed), "gram-altin");
      expect(dec(position.quantity).isNegative(), `seed ${seed}`).toBe(false);
      if (dec(position.quantity).isZero()) {
        expect(position.remainingCostBasis).toBe("0");
        expect(position.averageCost).toBeNull();
      }
    }
  });

  it("satış öncesi ve sonrası ortalama maliyet aynıdır", () => {
    for (const seed of seeds) {
      const entries = randomLedger(seed);
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index]!.kind !== "SELL") continue;
        const before = replayProduct(entries.slice(0, index), "gram-altin");
        const after = replayProduct(entries.slice(0, index + 1), "gram-altin");
        if (after.averageCost === null || before.averageCost === null) continue;
        // Çıkarılan maliyet 8 ondalığa yuvarlanır; kalan miktar çok küçükse (0,001 gr) bu
        // yuvarlama ortalamada en fazla 5e-6 fark yaratır. Tolerans 1e-4 (kuruşun yüzde biri).
        expect(dec(after.averageCost).minus(dec(before.averageCost)).abs().lessThan(dec("0.0001")), `seed ${seed} #${index}`).toBe(true);
      }
    }
  });

  it("aynı fiyatlı bölünmüş alışlar tek toplu alışla aynı sonucu üretir", () => {
    for (const seed of seeds.slice(0, 20)) {
      const random = rng(seed);
      const price = (3000 + Math.floor(random() * 3000)).toString();
      const parts = Array.from({ length: 4 }, () => dec(Math.floor(random() * 5000) + 1).div(1000));
      const total = parts.reduce((sum, part) => sum.plus(part), dec(0));
      const split = parts.map((part, index) =>
        makeEntry({ occurredAt: `2026-01-1${index}`, quantity: toDecimalString(part), unitPrice: price }),
      );
      const bulk = [makeEntry({ occurredAt: "2026-01-10", quantity: toDecimalString(total), unitPrice: price })];
      const a = replayProduct(split, "gram-altin");
      const b = replayProduct(bulk, "gram-altin");
      expect(a.quantity).toBe(b.quantity);
      expect(a.remainingCostBasis).toBe(b.remainingCostBasis);
      expect(a.averageCost).toBe(b.averageCost);
    }
  });

  it("işlem yeniden oynatma deterministiktir (giriş sırasından bağımsız)", () => {
    for (const seed of seeds) {
      const entries = randomLedger(seed);
      const shuffled = [...entries].sort(() => (rng(seed * 7)() < 0.5 ? -1 : 1));
      expect(replayProduct(shuffled, "gram-altin")).toEqual(replayProduct(entries, "gram-altin"));
    }
  });

  it("gerçekleşmiş K/Z = toplam net gelir − (toplam maliyet − kalan maliyet)", () => {
    for (const seed of seeds) {
      const entries = randomLedger(seed);
      const position = replayProduct(entries, "gram-altin");
      const proceeds = entries
        .filter((entry) => entry.kind === "SELL")
        .reduce((sum, entry) => sum.plus(dec(entry.netProceeds ?? "0")), dec(0));
      const paid = entries
        .filter((entry) => entry.kind !== "SELL")
        .reduce((sum, entry) => sum.plus(dec(entry.totalPaid ?? "0")), dec(0));
      const expected = proceeds.minus(paid.minus(dec(position.remainingCostBasis)));
      expect(dec(position.realizedPnl).minus(expected).abs().lessThan(dec("0.00000001")), `seed ${seed}`).toBe(true);
    }
  });
});
