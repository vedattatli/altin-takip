import type { GoldProduct, MeasureUnit } from "@/domain/types";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";

/**
 * MUHASEBE MODELİ — tipler.
 *
 * Yöntem: ÜRÜN BAZLI HAREKETLİ AĞIRLIKLI ORTALAMA MALİYET. Her ürün ayrı
 * maliyet havuzudur; yalnızca TL değerleri portföy düzeyinde toplanır.
 *
 * Bütün miktar ve para alanları ONDALIK DİZEDİR ("12.5", "5009.52380952").
 * JSON parse sonrasında Number'a çevrilmez (bkz. decimal.ts).
 */

export type TransactionKind = "OPENING_BALANCE" | "BUY" | "SELL";

/** Kullanıcının fiyatı nasıl girdiği. */
export type PricingInputMode = "UNIT_PRICE" | "TOTAL_AMOUNT" | "MARKET_BASELINE";

/** Maliyet bazının kökeni. */
export type CostBasisOrigin = "ACTUAL" | "ESTIMATED" | "MARKET_BASELINE";

export type LedgerStatus = "ACTIVE" | "VOID" | "REPLACED";

export const TRANSACTION_KINDS: readonly TransactionKind[] = ["OPENING_BALANCE", "BUY", "SELL"];
export const COST_BASIS_ORIGINS: readonly CostBasisOrigin[] = [
  "ACTUAL",
  "ESTIMATED",
  "MARKET_BASELINE",
];
export const LEDGER_STATUSES: readonly LedgerStatus[] = ["ACTIVE", "VOID", "REPLACED"];

/** Açılış bakiyesi için değiştirilemez fiyat anlık görüntüsü. */
export interface PriceSnapshotRecord {
  id: string;
  productId: string;
  /** Kuyumcunun kullanıcıdan aldığı fiyat (bozdurma). Başlangıç maliyet bazı buna dayanır. */
  liquidationPrice: string;
  /** Kuyumcunun kullanıcıya sattığı fiyat (yeniden alım). */
  replacementPrice: string;
  provider: string;
  market: string;
  currency: string;
  providerStatus: string;
  isRealMarketData: boolean;
  providerTimestamp: string;
  fetchedAt: string;
  createdAt: string;
}

/** İşlem defteri kaydı — kaynak gerçek. Değiştirilmez; yalnızca durumu değişir. */
export interface LedgerEntry {
  id: string;
  portfolioId: string;
  productId: string;
  kind: TransactionKind;
  quantity: string;
  unit: MeasureUnit;
  /** İşlem tarihi (YYYY-MM-DD). */
  occurredAt: string;
  pricingInputMode: PricingInputMode;
  /** Alışta kullanıcının gerçekten ödediği birim fiyat (piyasa fiyatı DEĞİL). */
  acquisitionUnitPrice: string | null;
  /** Satışta kullanıcının gerçekten aldığı birim fiyat (piyasa fiyatı DEĞİL). */
  disposalUnitPrice: string | null;
  grossAmount: string;
  fees: string;
  workmanship: string;
  /** BUY / OPENING_BALANCE: masraflar dâhil toplam edinim maliyeti. */
  totalPaid: string | null;
  /** SELL: masraflar düşülmüş net tahsilat. */
  netProceeds: string | null;
  costBasisOrigin: CostBasisOrigin;
  priceSnapshotId: string | null;
  priceSnapshot: PriceSnapshotRecord | null;
  note: string;
  status: LedgerStatus;
  voidedAt: string | null;
  voidReason: string | null;
  replacesTransactionId: string | null;
  replacedByTransactionId: string | null;
  clientRequestId: string | null;
  /** Deterministik sıralama için açık defter sırası. */
  ledgerSequence: number;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------- komutlar

/** Mevcut altın (açılış bakiyesi) maliyet girişi. */
export type OpeningCostMethod = "ACTUAL" | "ESTIMATED" | "MARKET_BASELINE";
export type OpeningCostInputMode = "AVERAGE_UNIT_COST" | "TOTAL_COST";

export interface OpeningBalanceCommand {
  kind: "OPENING_BALANCE";
  productId: string;
  quantity: string;
  /** Verilmezse bugün. */
  occurredAt?: string;
  costMethod: OpeningCostMethod;
  /** ACTUAL / ESTIMATED için zorunlu; MARKET_BASELINE'da yok sayılır. */
  costInputMode?: OpeningCostInputMode;
  costAmount?: string;
  note?: string;
  clientRequestId?: string;
}

export interface BuyCommand {
  kind: "BUY";
  productId: string;
  quantity: string;
  occurredAt: string;
  pricingInputMode: "UNIT_PRICE" | "TOTAL_AMOUNT";
  /** UNIT_PRICE modunda birim alış fiyatı. */
  unitPrice?: string;
  /** TOTAL_AMOUNT modunda bütün masraflar dâhil gerçekten ödenen toplam. */
  totalPaid?: string;
  workmanship?: string;
  fees?: string;
  note?: string;
  clientRequestId?: string;
}

export interface SellCommand {
  kind: "SELL";
  productId: string;
  quantity: string;
  occurredAt: string;
  pricingInputMode: "UNIT_PRICE" | "TOTAL_AMOUNT";
  /** UNIT_PRICE modunda birim satış fiyatı. */
  unitPrice?: string;
  /** TOTAL_AMOUNT modunda masraflar düşülmüş net tahsilat. */
  netProceeds?: string;
  fees?: string;
  note?: string;
  clientRequestId?: string;
}

export type LedgerCommand = OpeningBalanceCommand | BuyCommand | SellCommand;

/** Arka uca giden normalize edilmiş ekleme isteği (ilkel girdiler; tutarlar motorda hesaplanır). */
export interface LedgerAppendRequest {
  kind: TransactionKind;
  productId: string;
  quantity: string;
  unit: MeasureUnit;
  occurredAt: string;
  pricingInputMode: PricingInputMode;
  /** UNIT_PRICE modunda birim fiyat; MARKET_BASELINE'da snapshot'tan gelir. */
  unitPrice: string | null;
  /** TOTAL_AMOUNT modunda toplam ödenen (BUY) veya net tahsilat (SELL). */
  totalAmount: string | null;
  fees: string;
  workmanship: string;
  costBasisOrigin: CostBasisOrigin;
  note: string;
  clientRequestId: string | null;
  /** Sunucunun fiyat sağlayıcısından aldığı, değiştirilemez başlangıç fiyatı. */
  baselineSnapshot: PriceSnapshotInput | null;
}

export interface PriceSnapshotInput {
  productId: string;
  liquidationPrice: string;
  replacementPrice: string;
  provider: string;
  market: string;
  currency: string;
  providerStatus: string;
  isRealMarketData: boolean;
  providerTimestamp: string;
  fetchedAt: string;
}

/** Bir işlem için hesaplanmış tutarlar (deftere yazılan değerler). */
export interface LedgerAmounts {
  acquisitionUnitPrice: string | null;
  disposalUnitPrice: string | null;
  grossAmount: string;
  fees: string;
  workmanship: string;
  totalPaid: string | null;
  netProceeds: string | null;
}

// ----------------------------------------------------------------- pozisyon

export interface CostOriginFlags {
  actual: boolean;
  estimated: boolean;
  baseline: boolean;
}

export interface ProductPosition {
  productId: string;
  quantity: string;
  remainingCostBasis: string;
  /** Miktar sıfırsa null (belgelenmiş tek davranış). */
  averageCost: string | null;
  realizedPnl: string;
  costOrigins: CostOriginFlags;
  activeTransactionCount: number;
  /** Bu pozisyonu oluşturan son aktif defter sırası. */
  lastLedgerSequence: number;
}

export type CostQuality = "ACTUAL" | "ESTIMATED" | "BASELINE" | "MIXED" | "NONE";

export interface HoldingView {
  product: GoldProduct;
  position: ProductPosition;
  costQuality: CostQuality;
  pureGoldGrams: string;
  quote: PriceQuote | null;
  /** Fiyat kullanılabilir mi? Değilse değerleme alanları null'dır. */
  priceAvailable: boolean;
  liquidationValue: string | null;
  replacementValue: string | null;
  unrealizedPnl: string | null;
  unrealizedPnlPercent: string | null;
}

/** Ekleme sonucu: yazılan (veya idempotent tekrarda mevcut) kayıt ve güncel pozisyon. */
export interface LedgerAppendResult {
  entry: LedgerEntry;
  position: ProductPosition;
  /** true ise aynı istek kimliği daha önce işlenmişti; mevcut sonuç döndü. */
  replayed: boolean;
}

export interface LedgerVoidResult {
  entry: LedgerEntry;
  position: ProductPosition;
}

export interface LedgerReplaceResult {
  /** REPLACED durumuna alınan eski kayıt. */
  voided: LedgerEntry;
  /** Yerine geçen yeni kayıt. */
  entry: LedgerEntry;
  positions: ProductPosition[];
}

export type PnlLabelKind = "COST_BASIS" | "SINCE_TRACKING_START";

export interface AccountingSummary {
  holdings: HoldingView[];
  /** Kalan miktarı sıfırdan büyük ürün sayısı. */
  positionCount: number;
  totalRemainingCostBasis: string;
  totalPureGoldGrams: string;
  /** Fiyatı bilinen açık pozisyonların toplamı. */
  totalLiquidationValue: string;
  totalReplacementValue: string;
  totalUnrealizedPnl: string;
  totalRealizedPnl: string;
  /** realized + unrealized. Nakit hesabı tutulmaz; satış geliri portföy değerine eklenmez. */
  totalPnl: string;
  totalUnrealizedPnlPercent: string | null;
  hasMissingPrices: boolean;
  unpricedCostBasis: string;
  /** Portföyde ESTIMATED / MARKET_BASELINE kayıt varsa true. */
  hasEstimatedOrBaseline: boolean;
  pnlLabel: PnlLabelKind;
  /** Değerlemede kullanılan fiyat anlık görüntüsü (test verisi etiketiyle). */
  snapshot: PriceSnapshot | null;
  priceStatus: "ok" | "stale" | "unavailable";
}
