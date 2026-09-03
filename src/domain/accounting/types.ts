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

/**
 * İşlem defteri kaydı — kaynak gerçek. Değiştirilmez; yalnızca durumu değişir.
 *
 * FİYAT ALANLARI (birbirine karıştırılmaz):
 *   quotedAcquisitionUnitPrice   kullanıcının UNIT_PRICE modunda GİRDİĞİ birim alış fiyatı
 *                                (masraflar HARİÇ); TOTAL_AMOUNT modunda null;
 *                                MARKET_BASELINE'da anlık görüntünün bozdurma fiyatı.
 *   effectiveAcquisitionUnitCost totalPaid / quantity — işçilik ve masraflar DÂHİL efektif
 *                                birim maliyet (bilgi amaçlı, 8 ondalık).
 *   quotedDisposalUnitPrice      kullanıcının girdiği BRÜT birim satış fiyatı; TOTAL_AMOUNT'ta null.
 *   effectiveNetUnitProceeds     netProceeds / quantity — masraflar düşülmüş net birim tahsilat.
 * Ortalama maliyet her zaman totalPaid, gerçekleşmiş K/Z her zaman netProceeds üzerinden hesaplanır.
 */
export interface LedgerEntry {
  id: string;
  portfolioId: string;
  productId: string;
  kind: TransactionKind;
  quantity: string;
  unit: MeasureUnit;
  /** İşlem tarihi (YYYY-MM-DD, Europe/Istanbul). */
  occurredAt: string;
  /** İsteğe bağlı işlem saati (HH:MM, Europe/Istanbul). Girilmediyse null. */
  occurredTime: string | null;
  /** Sıralama anahtarı: tarih + (saat ?? 00:00) Europe/Istanbul → UTC ISO. */
  occurredAtInstant: string;
  pricingInputMode: PricingInputMode;
  quotedAcquisitionUnitPrice: string | null;
  effectiveAcquisitionUnitCost: string | null;
  quotedDisposalUnitPrice: string | null;
  effectiveNetUnitProceeds: string | null;
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
  /** Verilmezse bugün (Europe/Istanbul). */
  occurredAt?: string;
  /** İsteğe bağlı saat (HH:MM). */
  occurredTime?: string | null;
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
  /** İsteğe bağlı saat (HH:MM); aynı gün içindeki gerçek sırayı belirlemek için. */
  occurredTime?: string | null;
  pricingInputMode: "UNIT_PRICE" | "TOTAL_AMOUNT";
  /** UNIT_PRICE modunda birim alış fiyatı (masraflar hariç). */
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
  occurredTime?: string | null;
  pricingInputMode: "UNIT_PRICE" | "TOTAL_AMOUNT";
  /** UNIT_PRICE modunda brüt birim satış fiyatı. */
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
  /** YYYY-MM-DD (Europe/Istanbul). */
  occurredAt: string;
  /** HH:MM (Europe/Istanbul) veya null. */
  occurredTime: string | null;
  /** occurredAt + occurredTime'ın UTC ISO karşılığı (sıralama anahtarı). */
  occurredAtInstant: string;
  pricingInputMode: PricingInputMode;
  /** UNIT_PRICE modunda girilen birim fiyat; MARKET_BASELINE'da snapshot'tan gelir. */
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
  /** Sağlayıcının tazelik süresi (ms). Verilirse SQL doğrulaması da aynı sınırı uygular. */
  staleAfterMs?: number;
}

/** Bir işlem için hesaplanmış tutarlar (deftere yazılan değerler). */
export interface LedgerAmounts {
  quotedAcquisitionUnitPrice: string | null;
  effectiveAcquisitionUnitCost: string | null;
  quotedDisposalUnitPrice: string | null;
  effectiveNetUnitProceeds: string | null;
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

export const NO_ORIGINS: Readonly<CostOriginFlags> = Object.freeze({
  actual: false,
  estimated: false,
  baseline: false,
});

export interface ProductPosition {
  productId: string;
  quantity: string;
  remainingCostBasis: string;
  /** Miktar sıfırsa null (belgelenmiş tek davranış). */
  averageCost: string | null;
  realizedPnl: string;
  /**
   * ŞU ANDA ELDE KALAN miktarın maliyet kökenleri. Kalan miktar tam sıfıra indiğinde
   * sıfırlanır; pozisyon yalnızca ACTUAL alışla yeniden açılırsa yalnızca actual=true olur.
   */
  holdingCostOrigins: CostOriginFlags;
  /**
   * GERÇEKLEŞMİŞ K/Z'nin dayandığı maliyet kökenleri (tarihsel). Tam satıştan sonra
   * silinmez; "takip başlangıcından itibaren K/Z" etiketinin kalıcılığını belirler.
   */
  realizedPnlOrigins: CostOriginFlags;
  activeTransactionCount: number;
  /** Bu pozisyonu oluşturan son aktif defter sırası. */
  lastLedgerSequence: number;
}

export type CostQuality = "ACTUAL" | "ESTIMATED" | "BASELINE" | "MIXED" | "NONE";

export interface HoldingView {
  product: GoldProduct;
  position: ProductPosition;
  /** Elde kalan miktarın maliyet kalitesi (holdingCostOrigins'ten). */
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

/** full: bütün açık pozisyonlar fiyatlı; partial: bir kısmı; none: hiçbiri (veya açık pozisyon yok). */
export type ValuationCoverage = "full" | "partial" | "none";

/**
 * Değerleme durumu — yalnızca sağlayıcı meta durumuna değil, ELDEKİ pozisyonlar için
 * gerçekten kullanılabilir quote kapsamına göre hesaplanır.
 *   empty   : açık pozisyon yok (değerleme gerekmez)
 *   full    : bütün açık pozisyonlar fiyatlı
 *   partial : bir kısmı fiyatlı (kısmi toplam)
 *   none    : açık pozisyon var, hiçbiri fiyatlı değil ("Fiyat verisi kullanılamıyor")
 */
export type ValuationStatus = "empty" | "full" | "partial" | "none";

/**
 * Portföy durumu.
 *   NEVER_USED : hiç finansal işlem yok
 *   CLOSED     : geçmiş işlem / gerçekleşmiş K/Z var, açık pozisyon yok
 *   OPEN       : en az bir açık pozisyon var
 */
export type PortfolioState = "NEVER_USED" | "CLOSED" | "OPEN";

/**
 * Değerlemede kullanılan fiyat kaynağının kullanıcıya gösterilecek özeti.
 * Motor bu alanı üretmez; sunucu servisi doldurur (çoklu kaynak, Sprint 3).
 */
export interface PriceSourceInfo {
  providerCode: string | null;
  /** Kullanıcıya önce piyasa adı gösterilir. */
  displayName: string;
  /** Teknik sağlayıcı adı (detay/tooltip). */
  technicalName: string;
  marketId: string | null;
  marketDisplayName: string;
  attribution: string;
  /** Sağlayıcının üst kaynağı; bilinmiyorsa çoklu kaynakta "Çoklu Kaynak". */
  upstreamSourceLabel: string | null;
  isRealMarketData: boolean;
  lastQuoteAt: string | null;
  status: "ok" | "stale" | "unavailable" | "not_selected";
  coverage: number;
  userSelectable: boolean;
}

export interface AccountingSummary {
  holdings: HoldingView[];
  /** Kalan miktarı sıfırdan büyük ürün sayısı. */
  positionCount: number;
  /** positionCount ile aynı; açık semantik için. */
  activePositionCount: number;
  /** Defterdeki kayıt sayısı (ACTIVE + VOID + REPLACED). Bilinmiyorsa pozisyon satırlarından türetilir. */
  ledgerEntryCount: number;
  hasLedgerActivity: boolean;
  portfolioState: PortfolioState;
  valuationStatus: ValuationStatus;
  totalRemainingCostBasis: string;
  totalPureGoldGrams: string;
  /** YALNIZCA fiyatı bilinen açık pozisyonların toplamı (kısmi değerlemede eksik). */
  totalLiquidationValue: string;
  totalReplacementValue: string;
  totalUnrealizedPnl: string;
  /** Fiyat eksikliğinden ETKİLENMEZ; defterden gelir. */
  totalRealizedPnl: string;
  /** realized + unrealized. Kısmi değerlemede kesin toplam DEĞİLDİR (valuationCoverage). */
  totalPnl: string;
  totalUnrealizedPnlPercent: string | null;
  hasMissingPrices: boolean;
  /** Fiyatı olmayan açık pozisyonların maliyet toplamı. */
  unpricedCostBasis: string;
  valuationCoverage: ValuationCoverage;
  pricedPositionCount: number;
  unpricedPositionCount: number;
  /** Elde kalan pozisyonlarda ESTIMATED / MARKET_BASELINE köken varsa true. */
  holdingHasEstimatedOrBaseline: boolean;
  /** Gerçekleşmiş K/Z'nin bir kısmı ESTIMATED / MARKET_BASELINE döneminden geliyorsa true. */
  realizedHasEstimatedOrBaseline: boolean;
  /** İkisinden biri true ise true; K/Z etiketi buna göre seçilir. */
  hasEstimatedOrBaseline: boolean;
  pnlLabel: PnlLabelKind;
  /** Değerlemede kullanılan fiyat anlık görüntüsü (test verisi etiketiyle). */
  snapshot: PriceSnapshot | null;
  priceStatus: "ok" | "stale" | "unavailable";
  /** Aktif fiyat kaynağı (sunucu doldurur; demo modunda null olabilir). */
  priceSource?: PriceSourceInfo | null;
}
