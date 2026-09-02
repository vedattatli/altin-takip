import { dec, MAX_INTEGER_DIGITS, roundMoney, toDecimalString, ZERO, type Dec } from "./decimal";
import type { LedgerAmounts, LedgerAppendRequest } from "./types";

/**
 * SAYISAL ÜST SINIR — veritabanı numeric(20,8) sütunlarıyla uyumlu.
 * Tutarlar (brüt, toplam, net) ve türetilmiş birim değerler (total/quantity, net/quantity)
 * en fazla 12 tam basamak olabilir; aksi hâlde işlem reddedilir. Böylece TypeScript'in
 * kabul ettiği hiçbir girdi PostgreSQL taşması üretmez. Aynı sınır `ledger_compute_amounts`
 * içinde P0004 ile uygulanır.
 */
export const MAX_AMOUNT = dec(10).pow(MAX_INTEGER_DIGITS);
export const AMOUNT_TOO_LARGE_MESSAGE =
  "Tutar veya birim değer beklenenden çok büyük (en fazla 12 tam basamak). Miktar ve tutarı kontrol edin.";

function assertWithinLimit(...values: Dec[]): void {
  for (const value of values) {
    if (value.abs().greaterThanOrEqualTo(MAX_AMOUNT)) throw new LedgerAmountError(AMOUNT_TOO_LARGE_MESSAGE);
  }
}

/**
 * Tutar hesabı — defter kaydına yazılan değerler.
 *
 * ALIŞ (BUY / OPENING_BALANCE)
 *   UNIT_PRICE      : gross = quantity × unit_price
 *                     total_paid = gross + workmanship + fees
 *                     quoted_acquisition_unit_price = unit_price   (GİRİLEN, masraf hariç)
 *   TOTAL_AMOUNT    : total_paid = kullanıcının girdiği toplam (masraflar DÂHİL)
 *                     gross = total_paid − workmanship − fees   (bilgi amaçlı ayrıştırma;
 *                     masraf ikinci kez eklenmez); quoted fiyat UYDURULMAZ (null)
 *   MARKET_BASELINE : unit = snapshot bozdurma fiyatı, gross = total_paid = quantity × unit,
 *                     masraf yok; quoted = snapshot bozdurma fiyatı (değişmeden)
 *   effective_acquisition_unit_cost = total_paid / quantity  (masraflar DÂHİL; 8 ondalık)
 *
 * SATIŞ (SELL)
 *   UNIT_PRICE      : gross = quantity × unit_price, net = gross − fees
 *                     quoted_disposal_unit_price = unit_price (GİRİLEN brüt)
 *   TOTAL_AMOUNT    : net = kullanıcının girdiği net tahsilat, gross = net + fees; quoted null
 *   effective_net_unit_proceeds = net / quantity (8 ondalık)
 *
 * Ortalama maliyet HER ZAMAN total_paid, gerçekleşmiş K/Z HER ZAMAN net_proceeds üzerinden.
 * Aynı kurallar Postgres tarafında `ledger_compute_amounts` içinde uygulanır.
 */
export class LedgerAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAmountError";
  }
}

function effectiveUnit(amount: Dec, quantity: Dec): string {
  return toDecimalString(roundMoney(amount.div(quantity)));
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
    let quoted: string | null = null;
    if (request.pricingInputMode === "UNIT_PRICE") {
      const unit = dec(request.unitPrice ?? "");
      if (!unit.greaterThan(0)) throw new LedgerAmountError("Birim satış fiyatı sıfırdan büyük olmalıdır.");
      gross = quantity.times(unit);
      net = gross.minus(fees);
      quoted = toDecimalString(unit);
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
    assertWithinLimit(gross, net, fees, roundMoney(net.div(quantity)), roundMoney(gross.div(quantity)));
    return {
      quotedAcquisitionUnitPrice: null,
      effectiveAcquisitionUnitCost: null,
      quotedDisposalUnitPrice: quoted,
      effectiveNetUnitProceeds: effectiveUnit(net, quantity),
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
  let quoted: string | null = null;

  if (request.pricingInputMode === "MARKET_BASELINE") {
    const snapshot = request.baselineSnapshot;
    if (!snapshot) throw new LedgerAmountError("Başlangıç fiyatı anlık görüntüsü eksik.");
    const unit = dec(snapshot.liquidationPrice);
    if (!unit.greaterThan(0)) throw new LedgerAmountError("Başlangıç fiyatı geçersiz.");
    gross = quantity.times(unit);
    totalPaid = gross;
    feesOut = ZERO;
    workmanshipOut = ZERO;
    quoted = toDecimalString(unit);
  } else if (request.pricingInputMode === "UNIT_PRICE") {
    const unit = dec(request.unitPrice ?? "");
    if (!unit.greaterThan(0)) throw new LedgerAmountError("Birim alış fiyatı sıfırdan büyük olmalıdır.");
    gross = quantity.times(unit);
    totalPaid = gross.plus(workmanship).plus(fees);
    quoted = toDecimalString(unit);
  } else {
    totalPaid = dec(request.totalAmount ?? "");
    if (!totalPaid.greaterThan(0)) throw new LedgerAmountError("Toplam tutar sıfırdan büyük olmalıdır.");
    gross = totalPaid.minus(workmanship).minus(fees);
    if (gross.isNegative()) {
      throw new LedgerAmountError("Masraflar toplam ödenen tutarı aşamaz.");
    }
  }

  assertWithinLimit(gross, totalPaid, feesOut, workmanshipOut, roundMoney(totalPaid.div(quantity)));
  return {
    quotedAcquisitionUnitPrice: quoted,
    effectiveAcquisitionUnitCost: effectiveUnit(totalPaid, quantity),
    quotedDisposalUnitPrice: null,
    effectiveNetUnitProceeds: null,
    grossAmount: toDecimalString(gross),
    fees: toDecimalString(feesOut),
    workmanship: toDecimalString(workmanshipOut),
    totalPaid: toDecimalString(totalPaid),
    netProceeds: null,
  };
}
