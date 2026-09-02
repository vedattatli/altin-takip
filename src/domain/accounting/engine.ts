import { requireProduct } from "@/domain/catalog";
import { isSnapshotStale, type PriceQuote, type PriceSnapshot } from "@/prices/types";
import { dec, roundMoney, toDecimalString, ZERO, type Dec } from "./decimal";
import { instantMs } from "./time";
import type {
  AccountingSummary,
  CostOriginFlags,
  CostQuality,
  HoldingView,
  LedgerEntry,
  PnlLabelKind,
  ProductPosition,
  ValuationCoverage,
} from "./types";

/**
 * MUHASEBE MOTORU — saf, yan etkisiz.
 *
 * ÜRÜN BAZLI HAREKETLİ AĞIRLIKLI ORTALAMA MALİYET
 *
 *   Alış:   new_quantity            = old_quantity + purchased_quantity
 *           new_remaining_cost      = old_remaining_cost + acquisition_cost (total_paid)
 *           new_average_cost        = new_remaining_cost / new_quantity
 *
 *   Satış:  removed_cost_basis      = quantity_sold × average_cost_before_sale
 *                                     (uygulama: remaining_cost × quantity_sold / quantity_before,
 *                                      8 ondalığa HALF_UP; tamamı satılırsa kalan maliyetin tamamı)
 *           realized_pnl           += net_proceeds − removed_cost_basis
 *           remaining_quantity      = old_quantity − quantity_sold
 *           remaining_cost_basis    = old_remaining_cost − removed_cost_basis
 *           average_cost_after_sale = average_cost_before_sale (satış ortalamayı DEĞİŞTİRMEZ)
 *
 *   Kalan miktar sıfır olduğunda kalan maliyet tam sıfırdır, ortalama null'dur.
 *
 * MALİYET KÖKENİ (iki ayrı bayrak kümesi)
 *   holdingCostOrigins : elde kalan miktarın kökenleri. Alışta ilgili bayrak açılır;
 *                        satışta havuz kökenleri gerçekleşmiş K/Z kökenlerine kopyalanır;
 *                        miktar TAM SIFIRA inince holding bayrakları sıfırlanır.
 *   realizedPnlOrigins : gerçekleşmiş K/Z'nin dayandığı kökenler; hiç silinmez.
 *
 * Defter kaynak gerçektir: pozisyon her zaman AKTİF kayıtların deterministik
 * sırayla (occurredAtInstant, createdAt, ledgerSequence, id) yeniden oynatılmasıyla
 * elde edilir. Aynı algoritma Postgres'te `ledger_replay_product` içindedir.
 */

export class LedgerOversellError extends Error {
  constructor(
    readonly productId: string,
    readonly entryId: string,
    readonly occurredAt: string,
    readonly available: string,
    readonly requested: string,
  ) {
    super("Satış miktarı elinizdeki miktarı aşamaz.");
    this.name = "LedgerOversellError";
  }
}

function compareInstant(a: string, b: string): number {
  const am = instantMs(a);
  const bm = instantMs(b);
  if (am !== null && bm !== null) return am === bm ? 0 : am < bm ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    const byInstant = compareInstant(a.occurredAtInstant, b.occurredAtInstant);
    if (byInstant !== 0) return byInstant;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.ledgerSequence !== b.ledgerSequence) return a.ledgerSequence - b.ledgerSequence;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Yeniden eskiye (arayüz listesi). */
export function sortLedgerDesc(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return sortLedger(entries).reverse();
}

function noOrigins(): CostOriginFlags {
  return { actual: false, estimated: false, baseline: false };
}

export function emptyPosition(productId: string): ProductPosition {
  return {
    productId,
    quantity: "0",
    remainingCostBasis: "0",
    averageCost: null,
    realizedPnl: "0",
    holdingCostOrigins: noOrigins(),
    realizedPnlOrigins: noOrigins(),
    activeTransactionCount: 0,
    lastLedgerSequence: 0,
  };
}

interface Running {
  quantity: Dec;
  cost: Dec;
  realized: Dec;
  holding: CostOriginFlags;
  realizedOrigins: CostOriginFlags;
  count: number;
  lastSequence: number;
}

/** Tek bir ürünün AKTİF kayıtlarını oynatır; herhangi bir anda negatif miktar oluşursa fırlatır. */
export function replayProduct(entries: readonly LedgerEntry[], productId: string): ProductPosition {
  const running: Running = {
    quantity: ZERO,
    cost: ZERO,
    realized: ZERO,
    holding: noOrigins(),
    realizedOrigins: noOrigins(),
    count: 0,
    lastSequence: 0,
  };

  for (const entry of sortLedger(entries)) {
    if (entry.productId !== productId || entry.status !== "ACTIVE") continue;
    running.count += 1;
    running.lastSequence = Math.max(running.lastSequence, entry.ledgerSequence);
    const quantity = dec(entry.quantity);

    if (entry.kind === "BUY" || entry.kind === "OPENING_BALANCE") {
      running.quantity = running.quantity.plus(quantity);
      running.cost = running.cost.plus(dec(entry.totalPaid ?? "0"));
      if (entry.costBasisOrigin === "ACTUAL") running.holding.actual = true;
      if (entry.costBasisOrigin === "ESTIMATED") running.holding.estimated = true;
      if (entry.costBasisOrigin === "MARKET_BASELINE") running.holding.baseline = true;
      continue;
    }

    // SELL
    if (quantity.greaterThan(running.quantity)) {
      throw new LedgerOversellError(
        productId,
        entry.id,
        entry.occurredAt,
        toDecimalString(running.quantity),
        toDecimalString(quantity),
      );
    }
    const removed = quantity.equals(running.quantity)
      ? running.cost
      : roundMoney(running.cost.times(quantity).div(running.quantity));
    running.realized = running.realized.plus(dec(entry.netProceeds ?? "0").minus(removed));
    // Satılan miktarın maliyeti havuzun o andaki kökenlerine dayanır; tarihsel olarak korunur.
    running.realizedOrigins.actual ||= running.holding.actual;
    running.realizedOrigins.estimated ||= running.holding.estimated;
    running.realizedOrigins.baseline ||= running.holding.baseline;
    running.quantity = running.quantity.minus(quantity);
    running.cost = running.cost.minus(removed);
    if (running.quantity.isZero()) {
      running.cost = ZERO;
      // Pozisyon tamamen kapandı: elde kalan miktarın kökeni yok.
      running.holding = noOrigins();
    }
  }

  return {
    productId,
    quantity: toDecimalString(running.quantity),
    remainingCostBasis: toDecimalString(running.cost),
    averageCost: running.quantity.greaterThan(0)
      ? toDecimalString(roundMoney(running.cost.div(running.quantity)))
      : null,
    realizedPnl: toDecimalString(running.realized),
    holdingCostOrigins: running.holding,
    realizedPnlOrigins: running.realizedOrigins,
    activeTransactionCount: running.count,
    lastLedgerSequence: running.lastSequence,
  };
}

/** Bütün ürünleri oynatır. Ürünler birbirinden bağımsızdır; maliyetler karışmaz. */
export function replayLedger(entries: readonly LedgerEntry[]): Map<string, ProductPosition> {
  const productIds = new Set<string>();
  for (const entry of entries) if (entry.status === "ACTIVE") productIds.add(entry.productId);
  const positions = new Map<string, ProductPosition>();
  for (const productId of productIds) positions.set(productId, replayProduct(entries, productId));
  return positions;
}

/** Bir işlemin defteri geçerli bırakıp bırakmadığını söyler (negatif bakiye yoksa null). */
export function findLedgerOversell(entries: readonly LedgerEntry[]): LedgerOversellError | null {
  try {
    replayLedger(entries);
    return null;
  } catch (error) {
    if (error instanceof LedgerOversellError) return error;
    throw error;
  }
}

export function hasEstimatedOrBaseline(flags: CostOriginFlags): boolean {
  return flags.estimated || flags.baseline;
}

export function costQualityOf(flags: CostOriginFlags, quantity: string): CostQuality {
  if (!dec(quantity).greaterThan(0)) return "NONE";
  const count = Number(flags.actual) + Number(flags.estimated) + Number(flags.baseline);
  if (count === 0) return "NONE";
  if (count > 1) return "MIXED";
  if (flags.actual) return "ACTUAL";
  if (flags.estimated) return "ESTIMATED";
  return "BASELINE";
}

export const COST_QUALITY_LABELS: Record<CostQuality, string> = {
  ACTUAL: "Gerçek maliyet",
  ESTIMATED: "Tahmini maliyet",
  BASELINE: "Takip başlangıç değeri",
  MIXED: "Karışık maliyet",
  NONE: "—",
};

export const COST_QUALITY_DESCRIPTIONS: Record<CostQuality, string> = {
  ACTUAL: "Elde kalan miktarın tamamı kullanıcının girdiği gerçek alış maliyetlerine dayanır.",
  ESTIMATED: "Kullanıcının tahmini olarak girdiği maliyet; gerçek alış fiyatı değildir.",
  BASELINE:
    "Takibe başlandığı andaki bozdurma fiyatı. Gerçek tarihsel alış maliyeti değildir; kâr/zarar takip başlangıcından itibaren hesaplanır.",
  MIXED: "Elde kalan miktar gerçek maliyet ile tahmini/takip başlangıç değerinin birleşimidir.",
  NONE: "",
};

export const PNL_LABELS: Record<PnlLabelKind, string> = {
  COST_BASIS: "Maliyet bazlı K/Z",
  SINCE_TRACKING_START: "Takip başlangıcından itibaren K/Z",
};

export const PARTIAL_VALUATION_LABEL = "Kısmi değerleme";

function usableQuote(snapshot: PriceSnapshot | null, productId: string, now: number): PriceQuote | null {
  if (!snapshot || snapshot.status === "unavailable") return null;
  if (isSnapshotStale(snapshot, now)) return null;
  const quote = snapshot.quotes[productId];
  if (!quote || quote.status !== "ok") return null;
  if (!dec(quote.liquidationPrice).greaterThan(0) || !dec(quote.replacementPrice).greaterThan(0)) {
    return null;
  }
  if (dec(quote.replacementPrice).lessThan(dec(quote.liquidationPrice))) return null;
  return quote;
}

export function summaryPriceStatus(
  snapshot: PriceSnapshot | null,
  now: number,
): AccountingSummary["priceStatus"] {
  if (!snapshot || snapshot.status === "unavailable") return "unavailable";
  if (isSnapshotStale(snapshot, now)) return "stale";
  return "ok";
}

export const EMPTY_SUMMARY: AccountingSummary = {
  holdings: [],
  positionCount: 0,
  totalRemainingCostBasis: "0",
  totalPureGoldGrams: "0",
  totalLiquidationValue: "0",
  totalReplacementValue: "0",
  totalUnrealizedPnl: "0",
  totalRealizedPnl: "0",
  totalPnl: "0",
  totalUnrealizedPnlPercent: null,
  hasMissingPrices: false,
  unpricedCostBasis: "0",
  valuationCoverage: "none",
  pricedPositionCount: 0,
  unpricedPositionCount: 0,
  holdingHasEstimatedOrBaseline: false,
  realizedHasEstimatedOrBaseline: false,
  hasEstimatedOrBaseline: false,
  pnlLabel: "COST_BASIS",
  snapshot: null,
  priceStatus: "unavailable",
};

/**
 * Pozisyonları güncel fiyatla değerler.
 *
 *   liquidation_value = remaining_quantity × current_liquidation_price
 *   replacement_value = remaining_quantity × current_replacement_price
 *   unrealized_pnl    = liquidation_value − remaining_cost_basis
 *   total_pnl         = realized_pnl + unrealized_pnl
 *
 * Fiyat yoksa / geçersizse / bayatsa değerleme HESAPLANMIŞ GİBİ gösterilmez.
 * Başka ürünün fiyatından veya gram dönüşümünden tahmin YAPILMAZ. Bazı ürünlerin
 * fiyatı yoksa toplamlar KISMİDİR (valuationCoverage = "partial"); gerçekleşmiş K/Z
 * fiyattan bağımsızdır ve her zaman tamdır.
 */
export function valuePositions(
  positions: Iterable<ProductPosition>,
  snapshot: PriceSnapshot | null,
  now: number = Date.now(),
): AccountingSummary {
  const holdings: HoldingView[] = [];
  let totalCost = ZERO;
  let pricedCost = ZERO;
  let unpricedCost = ZERO;
  let totalLiquidation = ZERO;
  let totalReplacement = ZERO;
  let totalRealized = ZERO;
  let totalPureGrams = ZERO;
  let pricedCount = 0;
  let unpricedCount = 0;
  let holdingFlag = false;
  let realizedFlag = false;

  for (const position of positions) {
    const product = requireProduct(position.productId);
    const quantity = dec(position.quantity);
    const cost = dec(position.remainingCostBasis);
    const isOpen = quantity.greaterThan(0);
    const quote = isOpen ? usableQuote(snapshot, position.productId, now) : null;
    const costQuality = costQualityOf(position.holdingCostOrigins, position.quantity);

    totalRealized = totalRealized.plus(dec(position.realizedPnl));
    if (isOpen && hasEstimatedOrBaseline(position.holdingCostOrigins)) holdingFlag = true;
    if (hasEstimatedOrBaseline(position.realizedPnlOrigins)) realizedFlag = true;

    let liquidationValue: Dec | null = null;
    let replacementValue: Dec | null = null;
    let unrealized: Dec | null = null;
    let percent: string | null = null;
    const pureGrams = quantity.times(dec(product.pureGoldPerUnit));

    if (isOpen) {
      totalCost = totalCost.plus(cost);
      totalPureGrams = totalPureGrams.plus(pureGrams);
      if (quote) {
        liquidationValue = quantity.times(dec(quote.liquidationPrice));
        replacementValue = quantity.times(dec(quote.replacementPrice));
        unrealized = liquidationValue.minus(cost);
        pricedCost = pricedCost.plus(cost);
        totalLiquidation = totalLiquidation.plus(liquidationValue);
        totalReplacement = totalReplacement.plus(replacementValue);
        pricedCount += 1;
        percent = cost.greaterThan(0)
          ? toDecimalString(unrealized.div(cost).times(100).toDecimalPlaces(2))
          : null;
      } else {
        unpricedCount += 1;
        unpricedCost = unpricedCost.plus(cost);
      }
    } else {
      liquidationValue = ZERO;
      replacementValue = ZERO;
      unrealized = ZERO;
    }

    holdings.push({
      product,
      position,
      costQuality,
      pureGoldGrams: toDecimalString(pureGrams),
      quote,
      priceAvailable: !isOpen || quote !== null,
      liquidationValue: liquidationValue === null ? null : toDecimalString(liquidationValue),
      replacementValue: replacementValue === null ? null : toDecimalString(replacementValue),
      unrealizedPnl: unrealized === null ? null : toDecimalString(unrealized),
      unrealizedPnlPercent: percent,
    });
  }

  holdings.sort((a, b) => {
    const aOpen = dec(a.position.quantity).greaterThan(0);
    const bOpen = dec(b.position.quantity).greaterThan(0);
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aValue = dec(a.liquidationValue ?? a.position.remainingCostBasis);
    const bValue = dec(b.liquidationValue ?? b.position.remainingCostBasis);
    if (!aValue.equals(bValue)) return bValue.greaterThan(aValue) ? 1 : -1;
    return a.product.sortOrder - b.product.sortOrder;
  });

  const totalUnrealized = totalLiquidation.minus(pricedCost);
  const openCount = pricedCount + unpricedCount;
  const coverage: ValuationCoverage =
    openCount === 0 || pricedCount === 0 ? "none" : unpricedCount === 0 ? "full" : "partial";
  const anyEstimatedOrBaseline = holdingFlag || realizedFlag;

  return {
    holdings,
    positionCount: openCount,
    totalRemainingCostBasis: toDecimalString(totalCost),
    totalPureGoldGrams: toDecimalString(totalPureGrams),
    totalLiquidationValue: toDecimalString(totalLiquidation),
    totalReplacementValue: toDecimalString(totalReplacement),
    totalUnrealizedPnl: toDecimalString(totalUnrealized),
    totalRealizedPnl: toDecimalString(totalRealized),
    totalPnl: toDecimalString(totalRealized.plus(totalUnrealized)),
    totalUnrealizedPnlPercent: pricedCost.greaterThan(0)
      ? toDecimalString(totalUnrealized.div(pricedCost).times(100).toDecimalPlaces(2))
      : null,
    hasMissingPrices: unpricedCount > 0,
    unpricedCostBasis: toDecimalString(unpricedCost),
    valuationCoverage: coverage,
    pricedPositionCount: pricedCount,
    unpricedPositionCount: unpricedCount,
    holdingHasEstimatedOrBaseline: holdingFlag,
    realizedHasEstimatedOrBaseline: realizedFlag,
    hasEstimatedOrBaseline: anyEstimatedOrBaseline,
    pnlLabel: anyEstimatedOrBaseline ? "SINCE_TRACKING_START" : "COST_BASIS",
    snapshot,
    priceStatus: summaryPriceStatus(snapshot, now),
  };
}

/** Defterden özet: oynat + değerle. */
export function buildAccountingSummary(
  entries: readonly LedgerEntry[],
  snapshot: PriceSnapshot | null,
  now: number = Date.now(),
): AccountingSummary {
  const positions = replayLedger(entries);
  if (positions.size === 0) {
    return { ...EMPTY_SUMMARY, snapshot, priceStatus: summaryPriceStatus(snapshot, now) };
  }
  return valuePositions(positions.values(), snapshot, now);
}

/** Belirli bir ürün için satılabilir miktar (aktif kayıtlar; isteğe bağlı bir kayıt hariç). */
export function availableQuantityFor(
  entries: readonly LedgerEntry[],
  productId: string,
  options: { excludeEntryId?: string } = {},
): string {
  const filtered = options.excludeEntryId
    ? entries.filter((entry) => entry.id !== options.excludeEntryId)
    : entries;
  try {
    return replayProduct(filtered, productId).quantity;
  } catch (error) {
    if (error instanceof LedgerOversellError) return "0";
    throw error;
  }
}
