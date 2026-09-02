import { requireProduct } from "./catalog";
import type { GoldProduct, Transaction } from "./types";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";

/**
 * Portföy hesaplamaları — saf (yan etkisiz) fonksiyonlar.
 *
 * FİYAT YÖNÜ KURALI (asla ters çevrilmez):
 *   quote.buyPrice  = piyasanın ALIŞ fiyatı  -> kullanıcı bozdurursa ELİNE GEÇEN tutar
 *   quote.sellPrice = piyasanın SATIŞ fiyatı -> kullanıcı yeniden alırsa ÖDEYECEĞİ tutar
 * Bu nedenle her zaman buyPrice <= sellPrice olmalıdır;
 * "bozdurma değeri" buyPrice, "yeniden alım değeri" sellPrice ile hesaplanır.
 *
 * Maliyet yöntemi: ağırlıklı ortalama maliyet (kayan ortalama).
 */

export interface Holding {
  product: GoldProduct;
  /** Kalan miktar (ürünün kendi biriminde). */
  quantity: number;
  /** Kalan miktarın toplam maliyeti (TL), işçilik dâhil. */
  costBasis: number;
  /** Birim başına ortalama maliyet (TL). Miktar 0 ise 0. */
  averageUnitCost: number;
  /** Kalan miktarın has altın karşılığı (gram). */
  pureGoldGrams: number;
  /** Bu üründen gerçekleşmiş kâr/zarar (satışlardan). */
  realizedPnL: number;
  /** Bu ürüne ait fiyat kaydı. Fiyat yoksa null. */
  quote: PriceQuote | null;
  /** quantity * quote.buyPrice — fiyat yoksa null (sıfır DEĞİL). */
  liquidationValue: number | null;
  /** quantity * quote.sellPrice — fiyat yoksa null (sıfır DEĞİL). */
  repurchaseValue: number | null;
  /** liquidationValue eksi costBasis — fiyat yoksa null. */
  unrealizedPnL: number | null;
  /** Yüzde olarak gerçekleşmemiş getiri. Maliyet 0 veya fiyat yoksa null. */
  unrealizedPnLPercent: number | null;
  transactionCount: number;
}

export interface PortfolioSummary {
  holdings: Holding[];
  /** Kalan pozisyonu olan ürün sayısı. */
  positionCount: number;
  totalCostBasis: number;
  totalPureGoldGrams: number;
  totalRealizedPnL: number;
  /** Fiyatı bilinen pozisyonların toplam bozdurma değeri. */
  totalLiquidationValue: number;
  /** Fiyatı bilinen pozisyonların toplam yeniden alım değeri. */
  totalRepurchaseValue: number;
  totalUnrealizedPnL: number;
  totalUnrealizedPnLPercent: number | null;
  /** Fiyatı bulunamayan pozisyon varsa true — arayüz bunu açıkça belirtmelidir. */
  hasMissingPrices: boolean;
  /** Değerlemeye dâhil edilemeyen pozisyonların maliyeti. */
  unpricedCostBasis: number;
}

export const EMPTY_SUMMARY: PortfolioSummary = {
  holdings: [],
  positionCount: 0,
  totalCostBasis: 0,
  totalPureGoldGrams: 0,
  totalRealizedPnL: 0,
  totalLiquidationValue: 0,
  totalRepurchaseValue: 0,
  totalUnrealizedPnL: 0,
  totalUnrealizedPnLPercent: null,
  hasMissingPrices: false,
  unpricedCostBasis: 0,
};

/** Alışta işçilik maliyete eklenir; satışta net gelirden düşülür. */
export function transactionNetAmount(
  tx: Pick<Transaction, "quantity" | "unitPrice" | "feeAmount" | "side">,
): number {
  const gross = tx.quantity * tx.unitPrice;
  return tx.side === "buy" ? gross + tx.feeAmount : gross - tx.feeAmount;
}

/** İşlemleri tarihe, eşitlikte kayıt zamanına göre sıralar (orijinal diziyi bozmaz). */
export function sortTransactions(transactions: readonly Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => {
    if (a.tradedAt !== b.tradedAt) return a.tradedAt < b.tradedAt ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

interface RunningPosition {
  quantity: number;
  costBasis: number;
  realizedPnL: number;
  transactionCount: number;
}

function emptyPosition(): RunningPosition {
  return { quantity: 0, costBasis: 0, realizedPnL: 0, transactionCount: 0 };
}

function roundQuantity(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Kayan ortalama maliyet ile tek bir ürünün pozisyonunu ilerletir. */
function applyTransaction(position: RunningPosition, tx: Transaction): void {
  position.transactionCount += 1;

  if (tx.side === "buy") {
    position.quantity = roundQuantity(position.quantity + tx.quantity);
    position.costBasis += transactionNetAmount(tx);
    return;
  }

  const averageCost = position.quantity > 0 ? position.costBasis / position.quantity : 0;
  const soldQuantity = Math.min(tx.quantity, position.quantity);
  const removedCost = averageCost * soldQuantity;
  position.realizedPnL += transactionNetAmount(tx) - removedCost;
  position.quantity = roundQuantity(position.quantity - tx.quantity);
  position.costBasis -= removedCost;

  if (position.quantity <= 0) {
    // Pozisyon kapandı: kayan yuvarlama artıklarını temizle.
    position.quantity = Math.max(0, position.quantity);
    position.costBasis = 0;
  }
}

/** Belirli bir ürün için, verilen işlemler uygulandıktan sonra kalan miktar. */
export function availableQuantity(
  transactions: readonly Transaction[],
  productId: string,
  options: { excludeTransactionId?: string } = {},
): number {
  const position = emptyPosition();
  for (const tx of sortTransactions(transactions)) {
    if (tx.productId !== productId) continue;
    if (options.excludeTransactionId && tx.id === options.excludeTransactionId) continue;
    applyTransaction(position, tx);
  }
  return roundQuantity(position.quantity);
}

export function buildPortfolio(
  transactions: readonly Transaction[],
  snapshot: PriceSnapshot | null,
): PortfolioSummary {
  if (transactions.length === 0) return EMPTY_SUMMARY;

  const positions = new Map<string, RunningPosition>();
  for (const tx of sortTransactions(transactions)) {
    let position = positions.get(tx.productId);
    if (!position) {
      position = emptyPosition();
      positions.set(tx.productId, position);
    }
    applyTransaction(position, tx);
  }

  const holdings: Holding[] = [];
  for (const [productId, position] of positions) {
    const product = requireProduct(productId);
    const quote = snapshot?.quotes[productId] ?? null;
    const quantity = roundQuantity(position.quantity);
    const costBasis = roundMoney(position.costBasis);
    const isOpen = quantity > 0;
    const hasPrice = quote !== null;

    let liquidationValue: number | null = 0;
    let repurchaseValue: number | null = 0;
    if (isOpen) {
      liquidationValue = hasPrice ? roundMoney(quantity * quote.buyPrice) : null;
      repurchaseValue = hasPrice ? roundMoney(quantity * quote.sellPrice) : null;
    }

    holdings.push({
      product,
      quantity,
      costBasis,
      averageUnitCost: isOpen ? roundMoney(costBasis / quantity) : 0,
      pureGoldGrams: roundQuantity(quantity * product.pureGoldPerUnit),
      realizedPnL: roundMoney(position.realizedPnL),
      quote,
      liquidationValue,
      repurchaseValue,
      unrealizedPnL: liquidationValue === null ? null : roundMoney(liquidationValue - costBasis),
      unrealizedPnLPercent:
        liquidationValue === null || costBasis <= 0
          ? null
          : roundMoney(((liquidationValue - costBasis) / costBasis) * 100),
      transactionCount: position.transactionCount,
    });
  }

  holdings.sort((a, b) => {
    // Açık pozisyonlar önce, sonra değere göre, eşitlikte katalog sırası.
    const aOpen = a.quantity > 0;
    const bOpen = b.quantity > 0;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aValue = a.liquidationValue ?? a.costBasis;
    const bValue = b.liquidationValue ?? b.costBasis;
    if (aValue !== bValue) return bValue - aValue;
    return a.product.sortOrder - b.product.sortOrder;
  });

  const open = holdings.filter((holding) => holding.quantity > 0);
  const priced = open.filter((holding) => holding.liquidationValue !== null);
  const unpriced = open.filter((holding) => holding.liquidationValue === null);

  const totalCostBasis = roundMoney(open.reduce((sum, h) => sum + h.costBasis, 0));
  const pricedCostBasis = roundMoney(priced.reduce((sum, h) => sum + h.costBasis, 0));
  const totalLiquidationValue = roundMoney(
    priced.reduce((sum, h) => sum + (h.liquidationValue ?? 0), 0),
  );
  const totalRepurchaseValue = roundMoney(
    priced.reduce((sum, h) => sum + (h.repurchaseValue ?? 0), 0),
  );
  const totalUnrealizedPnL = roundMoney(totalLiquidationValue - pricedCostBasis);

  return {
    holdings,
    positionCount: open.length,
    totalCostBasis,
    totalPureGoldGrams: roundQuantity(open.reduce((sum, h) => sum + h.pureGoldGrams, 0)),
    totalRealizedPnL: roundMoney(holdings.reduce((sum, h) => sum + h.realizedPnL, 0)),
    totalLiquidationValue,
    totalRepurchaseValue,
    totalUnrealizedPnL,
    totalUnrealizedPnLPercent:
      pricedCostBasis > 0 ? roundMoney((totalUnrealizedPnL / pricedCostBasis) * 100) : null,
    hasMissingPrices: unpriced.length > 0,
    unpricedCostBasis: roundMoney(unpriced.reduce((sum, h) => sum + h.costBasis, 0)),
  };
}
