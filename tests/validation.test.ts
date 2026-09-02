import { describe, expect, it } from "vitest";

import {
  todayISO,
  totalFromUnitPrice,
  unitPriceFromTotal,
  validateTransaction,
} from "@/domain/validation";
import { makeInput, makeTransaction } from "./helpers";

const NOW = new Date("2026-02-01T09:00:00Z");

describe("işlem doğrulama", () => {
  it("geçerli işlemi kabul eder", () => {
    const result = validateTransaction(makeInput(), { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("negatif miktarı reddeder", () => {
    const result = validateTransaction(makeInput({ quantity: -5 }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toMatch(/sıfırdan büyük/);
  });

  it("sıfır miktarı reddeder", () => {
    const result = validateTransaction(makeInput({ quantity: 0 }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toBeDefined();
  });

  it("sayı olmayan miktarı reddeder", () => {
    const result = validateTransaction(makeInput({ quantity: Number.NaN }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toMatch(/sayı olmalıdır/);
  });

  it("negatif birim fiyatı reddeder", () => {
    const result = validateTransaction(makeInput({ unitPrice: -1 }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.unitPrice).toBeDefined();
  });

  it("negatif işçilik tutarını reddeder", () => {
    const result = validateTransaction(makeInput({ feeAmount: -10 }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.feeAmount).toMatch(/negatif olamaz/);
  });

  it("gelecek tarihli işlemi reddeder", () => {
    const result = validateTransaction(makeInput({ tradedAt: "2026-12-31" }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.tradedAt).toMatch(/gelecekte olamaz/);
  });

  it("bilinmeyen ürünü reddeder", () => {
    const result = validateTransaction(makeInput({ productId: "yok-boyle-urun" }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.productId).toBeDefined();
  });

  it("adet ile takip edilen üründe ondalık miktarı reddeder", () => {
    const result = validateTransaction(
      makeInput({ productId: "yeni-ceyrek", quantity: 1.5, unitPrice: 9000 }),
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toMatch(/tam sayı/);
  });

  it("ürünün birimiyle uyuşmayan birimi reddeder", () => {
    const result = validateTransaction(
      { ...makeInput({ productId: "yeni-ceyrek", unitPrice: 9000 }), unit: "gram" },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.unit).toBeDefined();
  });
});

describe("satış miktarı sınırı", () => {
  const holdings = [makeTransaction({ id: "a", tradedAt: "2026-01-05", quantity: 10 })];

  it("eldeki miktar kadar satışa izin verir", () => {
    const result = validateTransaction(makeInput({ side: "sell", quantity: 10 }), {
      existingTransactions: holdings,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("eldeki miktarı aşan satışı reddeder", () => {
    const result = validateTransaction(makeInput({ side: "sell", quantity: 11 }), {
      existingTransactions: holdings,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toMatch(/aşamaz/);
  });

  it("elde hiç yokken satışı reddeder", () => {
    const result = validateTransaction(
      makeInput({ productId: "yeni-ceyrek", side: "sell", quantity: 1, unitPrice: 9000 }),
      { existingTransactions: holdings, now: NOW },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.quantity).toMatch(/satılabilir/);
  });

  it("düzenlenen satış kaydını kendi kontrolüne dâhil etmez", () => {
    const withSale = [
      ...holdings,
      makeTransaction({ id: "b", tradedAt: "2026-01-10", side: "sell", quantity: 4 }),
    ];
    const result = validateTransaction(makeInput({ side: "sell", quantity: 9 }), {
      existingTransactions: withSale,
      editingTransactionId: "b",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe("fiyat dönüşümleri", () => {
  it("toplam tutardan birim fiyatı türetir", () => {
    expect(unitPriceFromTotal(54_000, 10)).toBe(5400);
  });

  it("miktar sıfırken güvenli değer döner", () => {
    expect(unitPriceFromTotal(54_000, 0)).toBe(0);
  });

  it("birim fiyattan toplamı hesaplar", () => {
    expect(totalFromUnitPrice(5400, 2.5)).toBe(13_500);
  });
});

describe("todayISO", () => {
  it("YYYY-AA-GG biçiminde tarih üretir", () => {
    expect(todayISO(new Date(2026, 8, 2))).toBe("2026-09-02");
  });
});
