import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { buildPortfolio } from "@/domain/portfolio";
import { IndexedDbPortfolioRepository } from "@/storage/indexeddb-repository";
import { MemoryPortfolioRepository } from "@/storage/memory-repository";
import { fixedSnapshot, makeInput } from "./helpers";

let dbCounter = 0;

function newRepository() {
  dbCounter += 1;
  return new IndexedDbPortfolioRepository(`altin-takip-test-${dbCounter}`);
}

describe("IndexedDB deposu (demo modu)", () => {
  let repository: IndexedDbPortfolioRepository;
  let dbName: string;

  beforeEach(() => {
    dbCounter += 1;
    dbName = `altin-takip-test-${dbCounter}`;
    repository = new IndexedDbPortfolioRepository(dbName);
  });

  it("yeni portföy boş başlar", async () => {
    const portfolio = await repository.getPortfolio();
    expect(portfolio.id).toBeTruthy();
    expect(await repository.listTransactions()).toHaveLength(0);
  });

  it("işlem ekler ve okur", async () => {
    const created = await repository.createTransaction(makeInput({ quantity: 5, unitPrice: 5100 }));
    expect(created.id).toBeTruthy();

    const rows = await repository.listTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);
  });

  it("sayfa yenilense de veriler korunur (yeni bağlantı aynı veriyi görür)", async () => {
    await repository.createTransaction(makeInput({ quantity: 3, unitPrice: 5200 }));

    // Yeni bir depo örneği = sayfanın yeniden yüklenmesi.
    const reopened = new IndexedDbPortfolioRepository(dbName);
    const rows = await reopened.listTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
  });

  it("kaydı günceller", async () => {
    const created = await repository.createTransaction(makeInput({ quantity: 5 }));
    const updated = await repository.updateTransaction(
      created.id,
      makeInput({ quantity: 8, unitPrice: 5300 }),
    );

    expect(updated.quantity).toBe(8);
    expect((await repository.listTransactions())[0].quantity).toBe(8);
  });

  it("kaydı siler ve toplamlar sıfırlanır", async () => {
    const snapshot = await fixedSnapshot();
    const created = await repository.createTransaction(makeInput({ quantity: 5, unitPrice: 5000 }));

    expect(buildPortfolio(await repository.listTransactions(), snapshot).totalCostBasis).toBe(
      25_000,
    );

    await repository.deleteTransaction(created.id);
    const summary = buildPortfolio(await repository.listTransactions(), snapshot);
    expect(summary.totalCostBasis).toBe(0);
    expect(summary.positionCount).toBe(0);
  });

  it("portföy adını değiştirir ve kalıcı kılar", async () => {
    await repository.renamePortfolio({ name: "Birikimlerim" });
    const reopened = new IndexedDbPortfolioRepository(dbName);
    expect((await reopened.getPortfolio()).name).toBe("Birikimlerim");
  });

  it("cihazlar arasında senkronize olmadığını bildirir", () => {
    expect(repository.syncsAcrossDevices).toBe(false);
    expect(repository.label).toMatch(/bu cihaz/i);
  });
});

describe("bellek deposu", () => {
  it("aynı sözleşmeyi uygular", async () => {
    const repository = new MemoryPortfolioRepository();
    expect(await repository.listTransactions()).toHaveLength(0);

    const created = await repository.createTransaction(makeInput({ quantity: 2 }));
    expect(await repository.listTransactions()).toHaveLength(1);

    await repository.deleteTransaction(created.id);
    expect(await repository.listTransactions()).toHaveLength(0);
  });

  it("olmayan kaydı güncellemeye çalışınca hata verir", async () => {
    const repository = new MemoryPortfolioRepository();
    await expect(repository.updateTransaction("yok", makeInput())).rejects.toThrow(
      /İşlem bulunamadı/,
    );
  });
});

describe("depo oluşturucu", () => {
  it("her yeni depo örneği boş portföyle başlar", async () => {
    const first = newRepository();
    const second = newRepository();
    expect(await first.listTransactions()).toHaveLength(0);
    expect(await second.listTransactions()).toHaveLength(0);
  });
});
