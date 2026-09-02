import { dec, roundMoney, toDecimalString } from "./decimal";
import { occurredAtInstantISO } from "./time";
import type { LedgerEntry } from "./types";

/**
 * Eski biçimde saklanmış defter kayıtlarını (yerel geliştirme deposu, IndexedDB demo
 * deposu) güncel `LedgerEntry` biçimine getirir. Sunucu tarafında bu iş migration
 * 0011 ile yapılır; burada yalnızca istemci/yerel depolar için aynı kurallar uygulanır:
 *
 *   - occurredTime yoksa null; occurredAtInstant yoksa tarih + 00:00 Europe/Istanbul.
 *   - Eski `acquisitionUnitPrice` (total/qty) → quoted = UNIT_PRICE modunda gross/qty,
 *     MARKET_BASELINE'da anlık görüntü bozdurma fiyatı, TOTAL_AMOUNT'ta null (uydurulmaz);
 *     effective = total/qty.
 *   - Eski `disposalUnitPrice` → quoted = UNIT_PRICE modunda gross/qty; effective = net/qty.
 */
export function normalizeLedgerEntry(raw: Record<string, unknown>): LedgerEntry {
  const entry = { ...raw } as Record<string, unknown> & Partial<LedgerEntry>;
  const quantity = dec(String(entry.quantity ?? "0"));
  const qtyPositive = quantity.greaterThan(0);
  const mode = entry.pricingInputMode ?? "UNIT_PRICE";
  const kind = entry.kind ?? "BUY";
  const unitOf = (amount: string | null | undefined) =>
    amount && qtyPositive ? toDecimalString(roundMoney(dec(amount).div(quantity))) : null;

  if (entry.occurredTime === undefined) entry.occurredTime = null;
  if (typeof entry.occurredAtInstant !== "string" || entry.occurredAtInstant === "") {
    entry.occurredAtInstant =
      occurredAtInstantISO(String(entry.occurredAt ?? ""), entry.occurredTime ?? null) ??
      String(entry.occurredAt ?? "");
  }

  if (entry.quotedAcquisitionUnitPrice === undefined) {
    if (kind === "SELL") entry.quotedAcquisitionUnitPrice = null;
    else if (mode === "TOTAL_AMOUNT") entry.quotedAcquisitionUnitPrice = null;
    else if (mode === "MARKET_BASELINE")
      entry.quotedAcquisitionUnitPrice = entry.priceSnapshot?.liquidationPrice ?? unitOf(entry.grossAmount);
    else entry.quotedAcquisitionUnitPrice = unitOf(entry.grossAmount);
  }
  if (entry.effectiveAcquisitionUnitCost === undefined) {
    entry.effectiveAcquisitionUnitCost = kind === "SELL" ? null : unitOf(entry.totalPaid);
  }
  if (entry.quotedDisposalUnitPrice === undefined) {
    entry.quotedDisposalUnitPrice = kind === "SELL" && mode === "UNIT_PRICE" ? unitOf(entry.grossAmount) : null;
  }
  if (entry.effectiveNetUnitProceeds === undefined) {
    entry.effectiveNetUnitProceeds = kind === "SELL" ? unitOf(entry.netProceeds) : null;
  }
  delete entry.acquisitionUnitPrice;
  delete entry.disposalUnitPrice;
  return entry as LedgerEntry;
}
