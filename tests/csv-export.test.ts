import { describe, expect, it } from "vitest";

import type { LedgerEntry } from "@/domain/accounting";
import { ledgerCsv } from "@/server/portfolio/csv";

/**
 * CSV DIŞA AKTARMA
 *
 * Kullanıcının kendi verisini indirmesi içindir. İki kural denetlenir:
 *  1. Ayırıcı, tırnak ve satır sonu doğru kaçırılır (Excel Türkçe yereli).
 *  2. Kullanıcının yazdığı serbest metin FORMÜL olarak çalıştırılamaz.
 */

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "BUY",
    productId: "gram-altin",
    quantity: "1",
    unit: "gram",
    occurredAt: "2026-01-10",
    occurredTime: null,
    quotedAcquisitionUnitPrice: "5000",
    quotedDisposalUnitPrice: null,
    effectiveAcquisitionUnitCost: "5000",
    effectiveNetUnitProceeds: null,
    grossAmount: "5000",
    workmanship: "0",
    fees: "0",
    totalPaid: "5000",
    netProceeds: null,
    costOrigin: "ACTUAL",
    status: "ACTIVE",
    voidReason: null,
    note: null,
    ...overrides,
  } as LedgerEntry;
}

describe("CSV dışa aktarma", () => {
  it("noktalı virgül, tırnak ve satır sonu kaçırılır", () => {
    const csv = ledgerCsv([entry({ note: 'ilk;ikinci "üçüncü"\nyeni satır' })]);
    expect(csv).toContain('"ilk;ikinci ""üçüncü""\nyeni satır"');
    expect(csv.split("\n")[0]).toContain("Girilen birim fiyat");
  });

  it("formül olarak başlayan serbest metin düz metne zorlanır", () => {
    for (const dangerous of ["=1+1", "+SUM(A1)", "-2+3", "@SUM(A1)", "\tHYPERLINK"]) {
      const csv = ledgerCsv([entry({ note: dangerous, voidReason: dangerous })]);
      // Hücre tek tırnakla başlar; ham "=..." biçiminde bir hücre kalmaz.
      expect(csv).toContain(`'${dangerous.replace(/\t/g, "\t")}`.slice(0, 3));
      expect(csv.includes(`;${dangerous};`)).toBe(false);
    }
  });

  it("zararsız metin değiştirilmez", () => {
    const csv = ledgerCsv([entry({ note: "düğün takısı" })]);
    expect(csv).toContain("düğün takısı");
    expect(csv).not.toContain("'düğün");
  });
});
