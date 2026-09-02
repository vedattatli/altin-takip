import { describe, expect, it } from "vitest";

import {
  parseDecimalInput,
  parseLedgerCommand,
  toDecimalString,
  validateLedgerCommand,
} from "@/domain/accounting";
import { buyCommand, openingCommand, sellCommand } from "./helpers";

/**
 * KOMUT DOĞRULAMA — istemci ve sunucuda aynı kurallar.
 * NaN / Infinity / bilimsel gösterim / aşırı büyük değer / yanlış ondalık reddedilir.
 */

const NOW = new Date("2026-03-01T12:00:00");

describe("ondalık girdi", () => {
  it("geçerli biçimleri kabul eder ve normalize eder", () => {
    for (const [input, expected] of [
      ["12", "12"],
      ["12.50", "12.5"],
      ["12,5", "12.5"],
      ["1.234,56", "1234.56"],
      ["0.000001", "0.000001"],
      [" 7 ", "7"],
    ] as const) {
      const result = parseDecimalInput(input, { maxScale: 6 });
      expect(result.ok, input).toBe(true);
      if (result.ok) expect(toDecimalString(result.value)).toBe(expected);
    }
  });

  it("NaN, Infinity, bilimsel gösterim, onaltılık ve aşırı büyük değerleri reddeder", () => {
    for (const input of [Number.NaN, Number.POSITIVE_INFINITY, "1e5", "1E-3", "0x10", "abc", "", "1.2.3", "1,2,3", "--1", "1234567890123", "١٢"]) {
      expect(parseDecimalInput(input, { maxScale: 6 }).ok, String(input)).toBe(false);
    }
  });

  it("negatif ve sıfırı politikaya göre reddeder", () => {
    expect(parseDecimalInput("-1", { maxScale: 2 }).ok).toBe(false);
    expect(parseDecimalInput("0", { maxScale: 2 }).ok).toBe(false);
    expect(parseDecimalInput("0", { maxScale: 2, allowZero: true }).ok).toBe(true);
  });

  it("izin verilenden fazla ondalığı reddeder", () => {
    expect(parseDecimalInput("1.1234567", { maxScale: 6 }).ok).toBe(false);
    expect(parseDecimalInput("1.5", { maxScale: 0 }).ok).toBe(false);
  });
});

describe("BUY komutu", () => {
  it("birim fiyat modunu kabul eder ve birimi katalogdan alır", () => {
    const result = parseLedgerCommand(buyCommand({ quantity: "2.5", unitPrice: "5000", fees: "10" }), { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.unit).toBe("gram");
      expect(result.request.costBasisOrigin).toBe("ACTUAL");
      expect(result.request.fees).toBe("10");
      expect(result.request.unitPrice).toBe("5000");
    }
  });

  it("toplam tutar modunda masraflar toplamı aşamaz", () => {
    const result = parseLedgerCommand(
      buyCommand({ pricingInputMode: "TOTAL_AMOUNT", totalPaid: "100", fees: "60", workmanship: "50", unitPrice: undefined }),
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.totalPaid).toMatch(/aşamaz/);
  });

  it("bilinmeyen ürün, geçersiz tür ve gelecek tarih reddedilir", () => {
    expect(parseLedgerCommand(buyCommand({ productId: "bitcoin" }), { now: NOW }).ok).toBe(false);
    expect(parseLedgerCommand({ ...buyCommand(), kind: "TRANSFER" }, { now: NOW }).ok).toBe(false);
    expect(parseLedgerCommand(buyCommand({ occurredAt: "2027-01-01" }), { now: NOW }).ok).toBe(false);
  });

  it("adet ürününde ondalık miktar reddedilir, gram ürününde 6 ondalık kabul edilir", () => {
    const piece = parseLedgerCommand(buyCommand({ productId: "yeni-ceyrek", quantity: "1.5", unitPrice: "11000" }), { now: NOW });
    expect(piece.ok).toBe(false);
    if (!piece.ok) expect(piece.errors.quantity).toMatch(/tam sayı/);

    const gram = parseLedgerCommand(buyCommand({ quantity: "0.000001" }), { now: NOW });
    expect(gram.ok).toBe(true);
    const tooFine = parseLedgerCommand(buyCommand({ quantity: "0.0000001" }), { now: NOW });
    expect(tooFine.ok).toBe(false);
  });

  it("NaN / Infinity / bilimsel gösterim / negatif / sıfır tutarlar reddedilir", () => {
    for (const unitPrice of ["NaN", "Infinity", "1e3", "-5", "0", "abc"]) {
      const result = parseLedgerCommand(buyCommand({ unitPrice }), { now: NOW });
      expect(result.ok, unitPrice).toBe(false);
    }
    expect(parseLedgerCommand(buyCommand({ quantity: "-1" }), { now: NOW }).ok).toBe(false);
    expect(parseLedgerCommand(buyCommand({ quantity: "0" }), { now: NOW }).ok).toBe(false);
  });

  it("istek kimliği biçimi denetlenir", () => {
    expect(parseLedgerCommand(buyCommand({ clientRequestId: "req-abc123-def456" }), { now: NOW }).ok).toBe(true);
    expect(parseLedgerCommand(buyCommand({ clientRequestId: "kısa" }), { now: NOW }).ok).toBe(false);
    expect(parseLedgerCommand(buyCommand({ clientRequestId: "x".repeat(100) }), { now: NOW }).ok).toBe(false);
  });
});

describe("SELL komutu", () => {
  it("net tahsilat modu ve masraf sınırı", () => {
    const ok = parseLedgerCommand(sellCommand({ pricingInputMode: "TOTAL_AMOUNT", netProceeds: "16800", unitPrice: undefined }), { now: NOW });
    expect(ok.ok).toBe(true);
    const bad = parseLedgerCommand(sellCommand({ quantity: "1", unitPrice: "100", fees: "200" }), { now: NOW });
    expect(bad.ok).toBe(false);
  });
});

describe("OPENING_BALANCE komutu", () => {
  it("gerçek maliyet: ortalama veya toplam girilir", () => {
    const average = parseLedgerCommand(openingCommand({ costInputMode: "AVERAGE_UNIT_COST", costAmount: "3800" }), { now: NOW });
    expect(average.ok).toBe(true);
    if (average.ok) {
      expect(average.request.pricingInputMode).toBe("UNIT_PRICE");
      expect(average.request.costBasisOrigin).toBe("ACTUAL");
      expect(average.request.occurredAt).toBe("2026-03-01");
    }
    const total = parseLedgerCommand(openingCommand({ costInputMode: "TOTAL_COST", costAmount: "57000" }), { now: NOW });
    expect(total.ok).toBe(true);
    if (total.ok) expect(total.request.totalAmount).toBe("57000");
  });

  it("tahmini maliyet ESTIMATED kökeniyle işaretlenir", () => {
    const result = parseLedgerCommand(openingCommand({ costMethod: "ESTIMATED", costAmount: "3500" }), { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.costBasisOrigin).toBe("ESTIMATED");
  });

  it("market baseline sunucu anlık görüntüsü olmadan oluşturulamaz", () => {
    const result = parseLedgerCommand(openingCommand({ costMethod: "MARKET_BASELINE" }), { now: NOW, baselineSnapshot: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.form).toMatch(/fiyat/i);
  });

  it("market baseline istemcinin fiyatını DEĞİL sunucu anlık görüntüsünü kullanır", () => {
    const result = parseLedgerCommand(
      { ...openingCommand({ costMethod: "MARKET_BASELINE" }), liquidationPrice: "1", costAmount: "1" },
      {
        now: NOW,
        baselineSnapshot: {
          productId: "gram-altin",
          liquidationPrice: "5000",
          replacementPrice: "5100",
          provider: "mock",
          market: "TEST",
          currency: "TRY",
          providerStatus: "ok",
          isRealMarketData: false,
          providerTimestamp: NOW.toISOString(),
          fetchedAt: NOW.toISOString(),
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.pricingInputMode).toBe("MARKET_BASELINE");
      expect(result.request.unitPrice).toBeNull();
      expect(result.request.baselineSnapshot?.liquidationPrice).toBe("5000");
    }
  });

  it("validateLedgerCommand istemci ön elemesi aynı hataları döner", () => {
    expect(validateLedgerCommand(openingCommand({ quantity: "0" }), NOW).quantity).toBeTruthy();
    expect(validateLedgerCommand(openingCommand({ costMethod: "MARKET_BASELINE" }), NOW)).toEqual({});
  });
});
