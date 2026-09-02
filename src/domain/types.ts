/** Ölçü birimi. Gram bazlı ürünler "gram", ziynet/külçe ürünleri "adet" ile takip edilir. */
export type MeasureUnit = "gram" | "adet";

/** Ürün grubu — listeleme ve filtreleme için kullanılır. */
export type ProductCategory = "gram" | "ziynet" | "kulce" | "ayarli";

export interface GoldProduct {
  /** Kalıcı kimlik. Veritabanı ve fiyat sağlayıcı bu kimliği kullanır. Asla değiştirilmez. */
  id: string;
  name: string;
  category: ProductCategory;
  unit: MeasureUnit;
  /** Saflık oranı (milyem / 1000). Örn. 22 ayar = 0.916 */
  milyem: number;
  /** Bir birimin brüt gram ağırlığı. Gram bazlı ürünlerde 1'dir. */
  gramWeight: number;
  /** Bir birimin has (saf) altın karşılığı, gram cinsinden. = milyem * gramWeight */
  pureGoldPerUnit: number;
  /** Listeleme sırası. */
  sortOrder: number;
}

/** İşlem yönü. "buy" = satın alma, "sell" = elden çıkarma. */
export type TradeSide = "buy" | "sell";

export interface Transaction {
  id: string;
  portfolioId: string;
  productId: string;
  side: TradeSide;
  /** Her zaman pozitif. Yön "side" alanında tutulur. */
  quantity: number;
  unit: MeasureUnit;
  /** ISO tarih (YYYY-MM-DD). */
  tradedAt: string;
  /** Birim başına fiyat (TL). Alışta ödenen, satışta alınan. */
  unitPrice: number;
  /** İşçilik / komisyon / makas farkı (TL). Alışta maliyete eklenir, satışta gelirden düşülür. */
  feeAmount: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type TransactionInput = Omit<
  Transaction,
  "id" | "portfolioId" | "createdAt" | "updatedAt"
>;

export interface PortfolioMeta {
  id: string;
  /** Kullanıcının seçtiği portföy adı. */
  name: string;
  /** Görünen kullanıcı adı. Kimlik doğrulama unsuru DEĞİLDİR. */
  displayName: string;
  createdAt: string;
  updatedAt: string;
}
