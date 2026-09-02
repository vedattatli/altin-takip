import { dec, toDecimalString, ZERO, type Dec } from "./decimal";
import type { LedgerAmounts, LedgerAppendRequest } from "./types";

/**
 * Tutar hesabı — defter kaydına yazılan değerler.
 *
 * ALIŞ (BUY / OPENING_BALANCE)
 *   UNIT_PRICE      : gross = quantity × unit_price
 *                     total_paid = gross + workmanship + fees
 *   TOTAL_AMOUNT    : total_paid = kullanıcının girdiği toplam (masraflar DÂHİL)
 *                     gross = total_paid − workmanship − fees   (yalnızca bilgi amaçlı ayrıştırma;
 *                     masraf ikinci kez eklenmez)
 *   MARKET_BASELINE : unit = snapshot bozdurma fiyatı, gross = total_paid = quantity × unit,
 *                     masraf yok
 *   acquisition_unit_price = total_paid / quantity  (bilgi amaçlı; 8 ondalık)
 *
 * SATIŞ (SELL)
 *   UNIT_PRICE      : gross = quantity × unit_price, net = gross − fees
 *   TOTAL_AMOUNT    : net = kullanıcının girdiği net tahsilat, gross = net + fees
 *   disposal_unit_price = gross / quantity (bilgi amaçlı; 8 ondalık)
 *
 * Aynı kurallar Postgres tarafında `ledger_compute_amounts` içinde uygulanır.
 */
export class LedgerAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAmountError";
  }
}

function informationalUnit(amount: Dec, quantity: Dec): Dec {
  return amount.div(quantity).toDecimalPlaces(8);
}

export function resolveLedgerAmounts(
  request: Pick<
    LedgerAppendRequest,
    | "kind"
    | "quantity"
    | "pricingInputMode"
    | "unitPrice"
    | "totalAmount"
    | "fees"
    | "workmanship"
    | "baselineSnapshot"
  >,
): LedgerAmounts {
  const quantity = dec(request.quantity);
  if (!quantity.greaterThan(0)) throw new LedgerAmountError("Miktar sıfırdan büyük olmalıdır.");
  const fees = dec(request.fees || "0");
  const workmanship = dec(request.workmanship || "0");
  if (fees.isNegative() || workmanship.isNegative()) {
    throw new LedgerAmountError("Masraflar negatif olamaz.");
  }

  if (request.kind === "SELL") {
    if (!workmanship.isZero()) throw new LedgerAmountError("Satışta işçilik alanı kullanılmaz.");
    let gross: Dec;
    let net: Dec;
    if (request.pricingInputMode === "UNIT_PRICE") {
      const unit = dec(request.unitPrice ?? "");
      if (!unit.greaterThan(0)) throw new LedgerAmountError("Birim satış fiyatı sıfırdan büyük olmalıdır.");
      gross = quantity.times(unit);
      net = gross.minus(fees);
    } else if (request.pricingInputMode === "TOTAL_AMOUNT") {
      net = dec(request.totalAmount ?? "");
      if (net.isNegative()) throw new LedgerAmountError("Net tahsilat negatif olamaz.");
      gross = net.plus(fees);
    } else {
      throw new LedgerAmountError("Satışta piyasa başlangıç fiyatı kullanılamaz.");
    }
    if (net.isNegative()) {
      throw new LedgerAmountError("Satış masrafları satış tutarını aşamaz.");
    }
    return {
      acquisitionUnitPrice: null,
      disposalUnitPrice: toDecimalString(informationalUnit(gross, quantity)),
      grossAmount: toDecimalString(gross),
      fees: toDecimalString(fees),
      workmanship: "0",
      totalPaid: null,
      netProceeds: toDecimalString(net),
    };
  }

  // BUY / OPENING_BALANCE
  let gross: Dec;
  let totalPaid: Dec;
  let feesOut = fees;
  let workmanshipOut = workmanship;

  if (request.pricingInputMode === "MARKET_BASELINE") {
    const snapshot = request.baselineSnapshot;
    if (!snapshot) throw new LedgerAmountError("Başlangıç fiyatı anlık görüntüsü eksik.");
    const unit = dec(snapshot.liquidationPrice);
    if (!unit.greaterThan(0)) throw new LedgerAmountError("Başlangıç fiyatı geçersiz.");
    gross = quantity.times(unit);
    totalPaid = gross;
    feesOut = ZERO;
    workmanshipOut = ZERO;
  } else if (request.pricingInputMode === "UNIT_PRICE") {
    const unit = dec(request.unitPrice ?? "");
    if (!unit.greaterThan(0)) throw new LedgerAmountError("Birim alış fiyatı sıfırdan büyük olmalıdır.");
    gross = quantity.times(unit);
    totalPaid = gross.plus(workmanship).plus(fees);
  } else {
    totalPaid = dec(request.totalAmount ?? "");
    if (!totalPaid.greaterThan(0)) throw new LedgerAmountError("Toplam tutar sıfırdan büyük olmalıdır.");
    gross = totalPaid.minus(workmanship).minus(fees);
    if (gross.isNegative()) {
      throw new LedgerAmountError("Masraflar toplam ödenen tutarı aşamaz.");
    }
  }

  return {
    acquisitionUnitPrice: toDecimalString(informationalUnit(totalPaid, quantity)),
    disposalUnitPrice: null,
    grossAmount: toDecimalString(gross),
    fees: toDecimalString(feesOut),
    workmanship: toDecimalString(workmanshipOut),
    totalPaid: toDecimalString(totalPaid),
    netProceeds: null,
  };
}
