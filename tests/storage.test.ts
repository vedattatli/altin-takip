import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { IndexedDbPortfolioRepository } from "@/storage/indexeddb-repository";
import { MemoryPortfolioRepository } from "@/storage/memory-repository";
import { buyCommand, openingCommand, sellCommand } from "./helpers";

let dbCounter = 0;

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
    expect(await repository.listLedger()).toHaveLength(0);
    const summary = await repository.getSummary();
    expect(summary.positionCount).toBe(0);
    expect(summary.totalRemainingCostBasis).toBe("0");
  });

  it("alış ekler, defter ve özet güncellenir", async () => {
    const result = await repository.appendTransaction(buyCommand({ quantity: "5", unitPrice: "5100" }));
    expect(result.entry.id).toBeTruthy();
    expect(result.position.quantity).toBe("5");
    expect(result.position.remainingCostBasis).toBe("25500");

    const rows = await repository.listLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe("5");
  });

  it("sayfa yenilense de veriler korunur (yeni bağlantı aynı veriyi görür)", async () => {
    await repository.appendTransaction(buyCommand({ quantity: "3", unitPrice: "5200" }));
    const reopened = new IndexedDbPortfolioRepository(dbName);
    const rows = await reopened.listLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe("3");
  });

  it("düzeltme eski kaydı REPLACED yapar, yenisini ekler", async () => {
    const created = await repository.appendTransaction(buyCommand({ quantity: "2", unitPrice: "5000" }));
    const replaced = await repository.replaceTransaction(created.entry.id, buyCommand({ quantity: "6", unitPrice: "5000" }));
    expect(replaced.voided.status).toBe("REPLACED");
    expect(replaced.entry.replacesTransactionId).toBe(created.entry.id);

    const rows = await repository.listLedger();
    expect(rows).toHaveLength(2);
    const summary = await repository.getSummary();
    expect(summary.totalRemainingCostBasis).toBe("30000");
  });

  it("iptal hard delete yapmaz; toplamlar sıfırlanır", async () => {
    const created = await repository.appendTransaction(buyCommand({ quantity: "4", unitPrice: "5000" }));
    await repository.voidTransaction(created.entry.id, "test");
    const rows = await repository.listLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("VOID");
    expect(rows[0]!.voidReason).toBe("test");
    expect((await repository.getSummary()).positionCount).toBe(0);
  });

  it("aynı istek kimliği ikinci kez gönderilince tek kayıt oluşur", async () => {
    const command = buyCommand({ quantity: "1", unitPrice: "5000", clientRequestId: "req-idem-000001" });
    const first = await repository.appendTransaction(command);
    const second = await repository.appendTransaction(command);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await repository.listLedger()).toHaveLength(1);
  });

  it("portföy adını değiştirir ve kalıcı kılar", async () => {
    await repository.renamePortfolio({ name: "Birikim" });
    expect((await new IndexedDbPortfolioRepository(dbName).getPortfolio()).name).toBe("Birikim");
  });

  it("cihazlar arasında senkronize olmadığını bildirir", () => {
    expect(repository.syncsAcrossDevices).toBe(false);
  });
});

describe("bellek deposu", () => {
  it("aynı sözleşmeyi uygular: açılış bakiyesi, alış, satış", async () => {
    const repository = new MemoryPortfolioRepository();
    await repository.appendTransaction(
      openingCommand({ quantity: "10", occurredAt: "2026-01-10", costInputMode: "TOTAL_COST", costAmount: "40000" }),
    );
    await repository.appendTransaction(buyCommand({ quantity: "5", unitPrice: "5000" }));
    const sale = await repository.appendTransaction(sellCommand({ quantity: "3", unitPrice: "5200" }));

    expect(sale.position.quantity).toBe("12");
    // Ortalama: 65.000 / 15 = 4.333,33333333; satış ortalamayı değiştirmez.
    expect(sale.position.averageCost).toBe("4333.33333333");
    // Çıkarılan maliyet 65.000 × 3 / 15 = 13.000; gelir 15.600 -> 2.600
    expect(sale.position.realizedPnl).toBe("2600");
    expect((await repository.listLedger())).toHaveLength(3);
  });

  it("eldeki miktarı aşan satış reddedilir", async () => {
    const repository = new MemoryPortfolioRepository();
    await repository.appendTransaction(buyCommand({ quantity: "2", unitPrice: "5000" }));
    await expect(repository.appendTransaction(sellCommand({ quantity: "3", unitPrice: "5000" }))).rejects.toThrow(/aşamaz/);
    expect(await repository.listLedger()).toHaveLength(1);
  });

  it("olmayan kaydı düzeltmeye çalışınca hata verir", async () => {
    const repository = new MemoryPortfolioRepository();
    await expect(repository.replaceTransaction("yok", buyCommand())).rejects.toThrow("İşlem bulunamadı.");
  });
});
