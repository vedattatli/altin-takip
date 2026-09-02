import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAccountingSummary,
  costQualityOf,
  findLedgerOversell,
  isValidCalendarDate,
  normalizeDecimalText,
  normalizeLedgerEntry,
  occurredAtInstantISO,
  parseDecimalInput,
  parseLedgerCommand,
  replayProduct,
  resolveLedgerAmounts,
  sortLedger,
  toInputDecimal,
  validatePriceSnapshotInput,
  zonedToInstantMs,
  type LedgerEntry,
  type PriceSnapshotInput,
} from "@/domain/accounting";
import { isSnapshotStale, SNAPSHOT_FUTURE_TOLERANCE_MS } from "@/prices/types";
import { buyCommand, makeEntry, openingCommand, sellCommand, snapshotWith } from "./helpers";

/**
 * SPRINT 1.1 — MUHASEBE BÜTÜNLÜĞÜ VE VERİ SEMANTİĞİ
 *
 *  1. Elde kalan pozisyon kökeni ile gerçekleşmiş K/Z kökeni ayrıdır.
 *  2. Girilen birim fiyat ile masraflar dâhil efektif birim maliyet ayrıdır.
 *  3. Tarih sıkı takvim doğrulaması; aynı gün gerçek sıra (saat).
 *  4. Fiyat anlık görüntüsü doğrulaması (makas, zaman, para birimi, ürün).
 *  5. Kısmi değerleme açıkça etiketlenir; gerçekleşmiş K/Z etkilenmez.
 *  6. Sayı girdisi: iç boşluk ve belirsiz ayırıcı reddedilir.
 *  7. Statik sınır: uygulama kodu defter tablolarına doğrudan yazmaz.
 */

const NOW = Date.parse("2026-03-01T10:00:00Z");
const nowIso = new Date(NOW).toISOString();

function baselineOpening(quantity: string, price: string, occurredAt: string): LedgerEntry {
  return makeEntry({
    kind: "OPENING_BALANCE",
    pricingInputMode: "MARKET_BASELINE",
    quantity,
    unitPrice: price,
    occurredAt,
  });
}

describe("1. maliyet kökeni: elde kalan ↔ gerçekleşmiş K/Z", () => {
  it("baseline pozisyon tamamen satılıp ACTUAL alışla yeniden açılınca elde kalan kalite ACTUAL olur; tarihsel köken korunur", () => {
    const entries = [
      baselineOpening("10", "5000", "2026-01-10"),
      makeEntry({ kind: "SELL", quantity: "10", unitPrice: "5200", occurredAt: "2026-01-20" }),
      makeEntry({ kind: "BUY", quantity: "5", unitPrice: "5100", occurredAt: "2026-02-01" }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("5");
    expect(position.remainingCostBasis).toBe("25500");
    expect(position.averageCost).toBe("5100");
    expect(position.holdingCostOrigins).toEqual({ actual: true, estimated: false, baseline: false });
    expect(costQualityOf(position.holdingCostOrigins, position.quantity)).toBe("ACTUAL");
    expect(position.realizedPnlOrigins).toEqual({ actual: false, estimated: false, baseline: true });
    expect(position.realizedPnl).toBe("2000");

    const summary = buildAccountingSummary(
      entries,
      snapshotWith({ "gram-altin": { liquidation: "5300", replacement: "5400" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.holdings[0]!.costQuality).toBe("ACTUAL");
    expect(summary.holdingHasEstimatedOrBaseline).toBe(false);
    expect(summary.realizedHasEstimatedOrBaseline).toBe(true);
    // Portföy genel K/Z açıklaması gerçek tarihsel maliyet iddiasında bulunmaz.
    expect(summary.pnlLabel).toBe("SINCE_TRACKING_START");
    expect(summary.hasEstimatedOrBaseline).toBe(true);
  });

  it("tamamen kapanmış ve yeniden açılmamış pozisyon: miktar 0, maliyet 0, ortalama null, holding bayrakları false, tarihsel köken korunur", () => {
    const entries = [
      baselineOpening("3", "10000", "2026-01-10"),
      makeEntry({ kind: "SELL", quantity: "3", unitPrice: "10500", occurredAt: "2026-01-11" }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.quantity).toBe("0");
    expect(position.remainingCostBasis).toBe("0");
    expect(position.averageCost).toBeNull();
    expect(position.holdingCostOrigins).toEqual({ actual: false, estimated: false, baseline: false });
    expect(position.realizedPnlOrigins).toEqual({ actual: false, estimated: false, baseline: true });
    expect(costQualityOf(position.holdingCostOrigins, position.quantity)).toBe("NONE");
  });

  it("kısmi satışta elde kalan köken değişmez; gerçekleşmiş K/Z kökeni havuzun o andaki kökenidir", () => {
    const entries = [
      makeEntry({ kind: "BUY", quantity: "4", unitPrice: "5000", occurredAt: "2026-01-10" }),
      baselineOpening("6", "5100", "2026-01-11"),
      makeEntry({ kind: "SELL", quantity: "2", unitPrice: "5200", occurredAt: "2026-01-12" }),
    ];
    const position = replayProduct(entries, "gram-altin");
    expect(position.holdingCostOrigins).toEqual({ actual: true, estimated: false, baseline: true });
    expect(position.realizedPnlOrigins).toEqual({ actual: true, estimated: false, baseline: true });
    expect(costQualityOf(position.holdingCostOrigins, position.quantity)).toBe("MIXED");
  });

  it("hiç satış yoksa gerçekleşmiş köken boştur; tamamı ACTUAL ise etiket maliyet bazlıdır", () => {
    const entries = [makeEntry({ kind: "BUY", quantity: "1", unitPrice: "5000" })];
    const position = replayProduct(entries, "gram-altin");
    expect(position.realizedPnlOrigins).toEqual({ actual: false, estimated: false, baseline: false });
    const summary = buildAccountingSummary(
      entries,
      snapshotWith({ "gram-altin": { liquidation: "5000", replacement: "5100" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.pnlLabel).toBe("COST_BASIS");
  });
});

describe("2. girilen fiyat ile efektif maliyet ayrımı", () => {
  it("10 gram × 5.000 + 500 işçilik + 100 masraf: quoted 5.000, gross 50.000, total 50.600, efektif 5.060, ortalama 5.060", () => {
    const amounts = resolveLedgerAmounts({
      kind: "BUY",
      quantity: "10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
      totalAmount: null,
      fees: "100",
      workmanship: "500",
      baselineSnapshot: null,
    });
    expect(amounts.quotedAcquisitionUnitPrice).toBe("5000");
    expect(amounts.grossAmount).toBe("50000");
    expect(amounts.totalPaid).toBe("50600");
    expect(amounts.effectiveAcquisitionUnitCost).toBe("5060");
    const entry = makeEntry({ quantity: "10", unitPrice: "5000", fees: "100", workmanship: "500" });
    expect(replayProduct([entry], "gram-altin").averageCost).toBe("5060");
    expect(entry.quotedAcquisitionUnitPrice).toBe("5000");
    expect(entry.effectiveAcquisitionUnitCost).toBe("5060");
  });

  it("TOTAL_AMOUNT modunda girilen birim fiyat UYDURULMAZ (null); efektif maliyet toplamdan türetilir", () => {
    const amounts = resolveLedgerAmounts({
      kind: "BUY",
      quantity: "10",
      pricingInputMode: "TOTAL_AMOUNT",
      unitPrice: null,
      totalAmount: "51200",
      fees: "0",
      workmanship: "300",
      baselineSnapshot: null,
    });
    expect(amounts.quotedAcquisitionUnitPrice).toBeNull();
    expect(amounts.effectiveAcquisitionUnitCost).toBe("5120");
    expect(amounts.grossAmount).toBe("50900");
  });

  it("MARKET_BASELINE'da girilen fiyat anlık görüntünün bozdurma fiyatıdır ve değişmez", () => {
    const entry = baselineOpening("2", "11000", "2026-01-10");
    expect(entry.quotedAcquisitionUnitPrice).toBe("11000");
    expect(entry.effectiveAcquisitionUnitCost).toBe("11000");
    expect(entry.totalPaid).toBe("22000");
  });

  it("satışta girilen brüt birim fiyat ile net birim tahsilat ayrıdır", () => {
    const amounts = resolveLedgerAmounts({
      kind: "SELL",
      quantity: "4",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "4200",
      totalAmount: null,
      fees: "200",
      workmanship: "0",
      baselineSnapshot: null,
    });
    expect(amounts.quotedDisposalUnitPrice).toBe("4200");
    expect(amounts.grossAmount).toBe("16800");
    expect(amounts.netProceeds).toBe("16600");
    expect(amounts.effectiveNetUnitProceeds).toBe("4150");
    const net = resolveLedgerAmounts({
      kind: "SELL",
      quantity: "4",
      pricingInputMode: "TOTAL_AMOUNT",
      unitPrice: null,
      totalAmount: "16600",
      fees: "200",
      workmanship: "0",
      baselineSnapshot: null,
    });
    expect(net.quotedDisposalUnitPrice).toBeNull();
    expect(net.effectiveNetUnitProceeds).toBe("4150");
  });

  it("eski kayıtlar güncel biçime getirilir: UNIT_PRICE'ta quoted = brüt/miktar, TOTAL_AMOUNT'ta null", () => {
    const legacyUnit = normalizeLedgerEntry({
      id: "old-1",
      kind: "BUY",
      pricingInputMode: "UNIT_PRICE",
      quantity: "10",
      grossAmount: "50000",
      totalPaid: "50600",
      fees: "100",
      workmanship: "500",
      acquisitionUnitPrice: "5060",
      occurredAt: "2026-01-10",
    });
    expect(legacyUnit.quotedAcquisitionUnitPrice).toBe("5000");
    expect(legacyUnit.effectiveAcquisitionUnitCost).toBe("5060");
    expect(legacyUnit.occurredTime).toBeNull();
    expect(legacyUnit.occurredAtInstant).toBe("2026-01-09T21:00:00.000Z");
    expect("acquisitionUnitPrice" in legacyUnit).toBe(false);

    const legacyTotal = normalizeLedgerEntry({
      id: "old-2",
      kind: "BUY",
      pricingInputMode: "TOTAL_AMOUNT",
      quantity: "10",
      grossAmount: "50900",
      totalPaid: "51200",
      acquisitionUnitPrice: "5120",
      occurredAt: "2026-01-11",
    });
    expect(legacyTotal.quotedAcquisitionUnitPrice).toBeNull();
    expect(legacyTotal.effectiveAcquisitionUnitCost).toBe("5120");

    const legacySell = normalizeLedgerEntry({
      id: "old-3",
      kind: "SELL",
      pricingInputMode: "UNIT_PRICE",
      quantity: "4",
      grossAmount: "16800",
      netProceeds: "16600",
      disposalUnitPrice: "4200",
      occurredAt: "2026-01-12",
    });
    expect(legacySell.quotedDisposalUnitPrice).toBe("4200");
    expect(legacySell.effectiveNetUnitProceeds).toBe("4150");
  });
});

describe("3. işlem tarihi ve aynı gün sıralaması", () => {
  const now = new Date("2028-03-01T12:00:00+03:00");

  it("2026-02-30 reddedilir, 2028-02-29 (artık yıl) kabul edilir, 2027-02-29 reddedilir", () => {
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
    expect(isValidCalendarDate("2027-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-04-31")).toBe(false);
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
    expect(parseLedgerCommand(buyCommand({ occurredAt: "2026-02-30" }), { now }).ok).toBe(false);
    const leap = parseLedgerCommand(buyCommand({ occurredAt: "2028-02-29" }), { now });
    expect(leap.ok).toBe(true);
    if (leap.ok) expect(leap.request.occurredAt).toBe("2028-02-29");
  });

  it("Europe/Istanbul yerel saati UTC ana çevrilir (sabit +03:00) ve saat girilmeyen kayıt günün başlangıcıdır", () => {
    expect(occurredAtInstantISO("2026-01-10", null)).toBe("2026-01-09T21:00:00.000Z");
    expect(occurredAtInstantISO("2026-01-10", "10:00")).toBe("2026-01-10T07:00:00.000Z");
    expect(occurredAtInstantISO("2026-07-10", "10:00")).toBe("2026-07-10T07:00:00.000Z");
    // 2016 öncesi yaz saati (DST) tarihsel kuralla uygulanır: Temmuz 2015 = UTC+03, Ocak 2015 = UTC+02.
    expect(occurredAtInstantISO("2015-07-10", "10:00")).toBe("2015-07-10T07:00:00.000Z");
    expect(occurredAtInstantISO("2015-01-10", "10:00")).toBe("2015-01-10T08:00:00.000Z");
    expect(zonedToInstantMs("2026-02-30", null)).toBeNull();
    expect(zonedToInstantMs("2026-01-10", "24:00")).toBeNull();
  });

  it("aynı gün 10:00 alış, 11:00 satış geçer; 11:00 alış ve 10:00 satış olarak girilirse replay kronolojik sıraya göre reddeder", () => {
    const buy = makeEntry({ kind: "BUY", quantity: "5", unitPrice: "5000", occurredAt: "2026-01-10", occurredTime: "10:00" });
    const sell = makeEntry({ kind: "SELL", quantity: "5", unitPrice: "5200", occurredAt: "2026-01-10", occurredTime: "11:00" });
    expect(findLedgerOversell([sell, buy])).toBeNull();
    expect(sortLedger([sell, buy]).map((entry) => entry.id)).toEqual([buy.id, sell.id]);

    const lateBuy = makeEntry({ kind: "BUY", quantity: "5", unitPrice: "5000", occurredAt: "2026-01-10", occurredTime: "11:00" });
    const earlySell = makeEntry({ kind: "SELL", quantity: "5", unitPrice: "5200", occurredAt: "2026-01-10", occurredTime: "10:00" });
    const oversell = findLedgerOversell([lateBuy, earlySell]);
    expect(oversell?.entryId).toBe(earlySell.id);
  });

  it("saat girilmeyen kayıt aynı günün saatli kayıtlarından önce gelir; created_at ve sıra numarası bağ bozucudur", () => {
    const dated = makeEntry({ kind: "BUY", quantity: "1", occurredAt: "2026-01-10" });
    const timed = makeEntry({ kind: "SELL", quantity: "1", unitPrice: "5100", occurredAt: "2026-01-10", occurredTime: "00:01" });
    expect(sortLedger([timed, dated]).map((entry) => entry.id)).toEqual([dated.id, timed.id]);
    expect(findLedgerOversell([timed, dated])).toBeNull();
  });

  it("gelecek tarih ve gelecek saat reddedilir; saat biçimi denetlenir", () => {
    const today = new Date("2026-03-01T12:00:00+03:00");
    expect(parseLedgerCommand(buyCommand({ occurredAt: "2026-03-02" }), { now: today }).ok).toBe(false);
    const future = parseLedgerCommand(buyCommand({ occurredAt: "2026-03-01", occurredTime: "13:00" }), { now: today });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.errors.occurredTime).toMatch(/gelecekte/);
    const past = parseLedgerCommand(buyCommand({ occurredAt: "2026-03-01", occurredTime: "11:30" }), { now: today });
    expect(past.ok).toBe(true);
    if (past.ok) {
      expect(past.request.occurredTime).toBe("11:30");
      expect(past.request.occurredAtInstant).toBe("2026-03-01T08:30:00.000Z");
    }
    const badTime = parseLedgerCommand(buyCommand({ occurredAt: "2026-02-01", occurredTime: "9:5" }), { now: today });
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) expect(badTime.errors.occurredTime).toBeTruthy();
    const opening = parseLedgerCommand(openingCommand({ occurredTime: "09:15" }), { now: today });
    expect(opening.ok).toBe(true);
    if (opening.ok) expect(opening.request.occurredAt).toBe("2026-03-01");
  });
});

describe("4. fiyat anlık görüntüsü doğrulaması", () => {
  const valid: PriceSnapshotInput = {
    productId: "gram-altin",
    liquidationPrice: "5000",
    replacementPrice: "5100",
    provider: "mock",
    market: "TEST",
    currency: "TRY",
    providerStatus: "ok",
    isRealMarketData: false,
    providerTimestamp: nowIso,
    fetchedAt: nowIso,
  };

  it("geçerli anlık görüntü kabul edilir", () => {
    expect(validatePriceSnapshotInput(valid, "gram-altin", NOW)).toBeNull();
  });

  it("ters makas, sıfır fiyat, yanlış para birimi, boş sağlayıcı/piyasa, başka ürün ve ok olmayan durum reddedilir", () => {
    expect(validatePriceSnapshotInput({ ...valid, replacementPrice: "4999" }, "gram-altin", NOW)).toMatch(/makas/);
    expect(validatePriceSnapshotInput({ ...valid, liquidationPrice: "0" }, "gram-altin", NOW)).toMatch(/Bozdurma/);
    expect(validatePriceSnapshotInput({ ...valid, replacementPrice: "-1" }, "gram-altin", NOW)).toMatch(/Yeniden alım/);
    expect(validatePriceSnapshotInput({ ...valid, currency: "USD" }, "gram-altin", NOW)).toMatch(/TL/);
    expect(validatePriceSnapshotInput({ ...valid, provider: " " }, "gram-altin", NOW)).toMatch(/sağlayıcı/);
    expect(validatePriceSnapshotInput({ ...valid, market: "" }, "gram-altin", NOW)).toMatch(/piyasa/);
    expect(validatePriceSnapshotInput(valid, "yeni-ceyrek", NOW)).toMatch(/başka bir ürün/);
    expect(validatePriceSnapshotInput({ ...valid, providerStatus: "stale" }, "gram-altin", NOW)).toMatch(/kullanılamıyor/);
  });

  it("geçersiz, gelecekteki ve bayat zaman damgaları reddedilir", () => {
    expect(validatePriceSnapshotInput({ ...valid, providerTimestamp: "dün" }, "gram-altin", NOW)).toMatch(/zamanı geçersiz/);
    const future = new Date(NOW + 10 * 60_000).toISOString();
    expect(validatePriceSnapshotInput({ ...valid, fetchedAt: future }, "gram-altin", NOW)).toMatch(/gelecekte/);
    const slightlyAhead = new Date(NOW + 60_000).toISOString();
    expect(validatePriceSnapshotInput({ ...valid, fetchedAt: slightlyAhead, providerTimestamp: slightlyAhead }, "gram-altin", NOW)).toBeNull();
    const stale = new Date(NOW - 16 * 60_000).toISOString();
    expect(validatePriceSnapshotInput({ ...valid, fetchedAt: stale }, "gram-altin", NOW)).toMatch(/bayat/);
  });

  it("parseLedgerCommand MARKET_BASELINE için anlık görüntüyü doğrular", () => {
    const now = new Date(NOW);
    const bad = parseLedgerCommand(openingCommand({ costMethod: "MARKET_BASELINE" }), {
      now,
      baselineSnapshot: { ...valid, replacementPrice: "1" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.form).toMatch(/makas/);
    const good = parseLedgerCommand(openingCommand({ costMethod: "MARKET_BASELINE" }), { now, baselineSnapshot: valid });
    expect(good.ok).toBe(true);
  });

  it("isSnapshotStale: geçersiz tarih, fazla eski ve toleransı aşan gelecek zaman için true döner", () => {
    const base = snapshotWith({ "gram-altin": { liquidation: "5000", replacement: "5100" } }, { fetchedAt: nowIso });
    expect(isSnapshotStale({ ...base, fetchedAt: "geçersiz" }, NOW)).toBe(true);
    expect(isSnapshotStale({ ...base, fetchedAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW)).toBe(true);
    expect(isSnapshotStale({ ...base, fetchedAt: new Date(NOW + SNAPSHOT_FUTURE_TOLERANCE_MS + 1000).toISOString() }, NOW)).toBe(true);
    expect(isSnapshotStale({ ...base, fetchedAt: new Date(NOW + 30_000).toISOString() }, NOW)).toBe(false);
    expect(isSnapshotStale(base, NOW)).toBe(false);
  });
});

describe("5. kısmi değerleme", () => {
  const entries = [
    makeEntry({ productId: "gram-altin", quantity: "10", unitPrice: "5000", occurredAt: "2026-01-10" }),
    makeEntry({ productId: "yeni-ceyrek", quantity: "2", unitPrice: "11000", occurredAt: "2026-01-11" }),
    makeEntry({ productId: "gram-altin", kind: "SELL", quantity: "2", unitPrice: "5300", occurredAt: "2026-01-12" }),
  ];

  it("bazı ürünlerin fiyatı yoksa toplamlar yalnızca fiyatı bulunanları kapsar ve 'partial' etiketlenir", () => {
    const summary = buildAccountingSummary(
      entries,
      snapshotWith({ "gram-altin": { liquidation: "5200", replacement: "5300" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.valuationCoverage).toBe("partial");
    expect(summary.pricedPositionCount).toBe(1);
    expect(summary.unpricedPositionCount).toBe(1);
    expect(summary.hasMissingPrices).toBe(true);
    expect(summary.totalLiquidationValue).toBe("41600");
    expect(summary.totalUnrealizedPnl).toBe("1600");
    expect(summary.unpricedCostBasis).toBe("22000");
    // Gerçekleşmiş K/Z fiyat eksikliğinden etkilenmez.
    expect(summary.totalRealizedPnl).toBe("600");
    expect(summary.totalPnl).toBe("2200");
    const unpriced = summary.holdings.find((holding) => holding.product.id === "yeni-ceyrek")!;
    expect(unpriced.priceAvailable).toBe(false);
    expect(unpriced.liquidationValue).toBeNull();
  });

  it("bütün ürünler fiyatlıysa 'full', hiçbiri fiyatlı değilse 'none'", () => {
    const full = buildAccountingSummary(
      entries,
      snapshotWith(
        { "gram-altin": { liquidation: "5200", replacement: "5300" }, "yeni-ceyrek": { liquidation: "11000", replacement: "11300" } },
        { fetchedAt: nowIso },
      ),
      NOW,
    );
    expect(full.valuationCoverage).toBe("full");
    const none = buildAccountingSummary(entries, null, NOW);
    expect(none.valuationCoverage).toBe("none");
    expect(none.totalRealizedPnl).toBe("600");
    expect(none.priceStatus).toBe("unavailable");
  });

  it("ters makaslı fiyat değerlemede kullanılmaz", () => {
    const summary = buildAccountingSummary(
      entries,
      snapshotWith({ "gram-altin": { liquidation: "5200", replacement: "5100" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.valuationCoverage).toBe("none");
    expect(summary.hasMissingPrices).toBe(true);
  });
});

describe("6. sayı girdisi sertleştirmesi", () => {
  it("iç boşluk reddedilir ('1 2' → 12 olmaz)", () => {
    const result = parseDecimalInput("1 2", { maxScale: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/boşluk/);
    expect(parseDecimalInput("1 2", { maxScale: 2 }).ok).toBe(false);
    expect(parseDecimalInput(" 12 ", { maxScale: 2 }).ok).toBe(true);
  });

  it("Türkçe biçimler doğru okunur; belirsiz ve karışık ayırıcılar reddedilir", () => {
    const accepted: Array<[string, string]> = [
      ["1.234,56", "1234.56"],
      ["12,5", "12.5"],
      ["12.5", "12.5"],
      ["1.234.567", "1234567"],
      ["1.234.567,89", "1234567.89"],
      ["0.125", "0.125"],
      ["5000", "5000"],
      ["5.0001", "5.0001"],
      ["1234.567", "1234.567"],
    ];
    for (const [input, expected] of accepted) {
      const result = normalizeDecimalText(input);
      expect(result.ok, input).toBe(true);
      if (result.ok) expect(result.text).toBe(expected);
    }
    for (const input of ["5.000", "1.234", "12.500", "1,234.56", "1.2.3", "1,2,3", "1e5", "1.23.456", "1.2345,6", "12,", ",5", "."]) {
      expect(normalizeDecimalText(input).ok, input).toBe(false);
    }
    const ambiguous = parseDecimalInput("5.000", { maxScale: 4 });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error).toMatch(/belirsiz/);
  });

  it("form girişi için Türkçe biçim üretir; istemci ve sunucu aynı sonucu verir", () => {
    expect(toInputDecimal("5.125")).toBe("5,125");
    expect(toInputDecimal("5000")).toBe("5000");
    const client = parseDecimalInput(toInputDecimal("5.125"), { maxScale: 6 });
    const server = parseDecimalInput("5,125", { maxScale: 6 });
    expect(client.ok && server.ok && client.value.equals(server.value)).toBe(true);
    const command = parseLedgerCommand(buyCommand({ quantity: "5,125", unitPrice: "5.400,50" }), { now: new Date(NOW) });
    expect(command.ok).toBe(true);
    if (command.ok) {
      expect(command.request.quantity).toBe("5.125");
      expect(command.request.unitPrice).toBe("5400.5");
    }
  });

  it("gram/adet hassasiyet kuralları korunur", () => {
    expect(parseLedgerCommand(buyCommand({ quantity: "0,000001" }), { now: new Date(NOW) }).ok).toBe(true);
    expect(parseLedgerCommand(buyCommand({ quantity: "0,0000001" }), { now: new Date(NOW) }).ok).toBe(false);
    expect(parseLedgerCommand(buyCommand({ productId: "yeni-ceyrek", quantity: "1,5", unitPrice: "11000" }), { now: new Date(NOW) }).ok).toBe(false);
    expect(parseLedgerCommand(sellCommand({ quantity: "2,5" }), { now: new Date(NOW) }).ok).toBe(true);
  });
});

describe("7. statik sınır: uygulama kodu defter tablolarına doğrudan yazmaz", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path);
    }
    return out;
  }

  it("src altında transactions / price_snapshots / portfolio_positions tablolarına .from() ile erişim yoktur", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const code = readFileSync(file, "utf8");
      if (/\.from\(\s*["'`](transactions|price_snapshots|portfolio_positions)["'`]\s*\)/.test(code)) {
        offenders.push(file);
      }
      if (/\.rpc\(\s*["'`](ledger_rebuild_position|ledger_replay_product|ledger_compute_amounts)["'`]/.test(code)) {
        offenders.push(`${file} (dahili yardımcı RPC)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("migration 0011 service_role'den doğrudan yazma izinlerini kaldırır ve RPC yolunu korur", () => {
    const sql = readFileSync(join("supabase", "migrations", "0011_accounting_integrity.sql"), "utf8");
    expect(sql).toMatch(/revoke insert, update, delete[^\n]*on table public\.transactions from service_role/);
    expect(sql).toMatch(/revoke insert, update, delete[^\n]*on table public\.price_snapshots from service_role/);
    expect(sql).toContain("grant select on table public.transactions to service_role");
    expect(sql).not.toMatch(/grant [^\n]*(insert|update|delete)[^\n]*on table public\.(transactions|price_snapshots|portfolio_positions)/);
    expect(sql).toContain("grant execute on function %s to service_role");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public");
    expect(sql).toContain("realized_has_baseline");
    expect(sql).toContain("quoted_acquisition_unit_price");
    expect(sql).toContain("effective_acquisition_unit_cost");
    expect(sql).toContain("occurred_at timestamptz");
    expect(sql).toContain("price_snapshots_spread_consistent");
    expect(sql).toContain("order by occurred_at, created_at, ledger_sequence, id");
  });
});
