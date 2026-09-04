/** Ölçü birimi. Gram bazlı ürünler "gram", ziynet/külçe ürünleri "adet" ile takip edilir. */
export type MeasureUnit = "gram" | "adet";

/** Ürün grubu — listeleme ve filtreleme için kullanılır. */
/**
 * Ürün kategorileri.
 *
 * "gumus" ve "doviz" ALTIN DEĞİLDİR. Bu ürünler portföy DEĞERİNE girer ama
 * "has altın" gramına GİRMEZ: milyem değerleri 0'dır, dolayısıyla
 * `pureGoldPerUnit` de 0 olur ve toplam saf altın hesabını kirletmezler.
 * Aksi hâlde "108 gr has altın" gibi bir satır yalan söylerdi.
 */
export type ProductCategory = "gram" | "ziynet" | "kulce" | "ayarli" | "gumus" | "doviz";

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
  /**
   * Miktarın en fazla kaç ondalık basamağı olabilir.
   *
   * BU KURAL BİRİMDEN TÜRETİLEMEZ. "adet" birimi iki farklı şeyi taşır:
   * ziynet altını BÖLÜNEMEZ (yarım çeyrek diye bir şey yoktur, miktar tam
   * sayıdır), döviz ise "adet" ile tutulur ama BÖLÜNEBİLİR — 1.500,50 dolar
   * geçerli bir bakiyedir.
   *
   * Kural bir zamanlar `unit === "adet"` idi; döviz eklenince yanlışa döndü ve
   * kullanıcı kesirli döviz giremez oldu. Bu yüzden ölçek artık ürünün kendi
   * özelliğidir. Aynı sınır veritabanında `enforce_transaction_unit`
   * tetikleyicisinde uygulanır.
   */
  quantityScale: number;
  /** Listeleme sırası. */
  sortOrder: number;
}

export interface PortfolioMeta {
  id: string;
  /** Kullanıcının seçtiği portföy adı. */
  name: string;
  /** Görünen kullanıcı adı. Kimlik doğrulama unsuru DEĞİLDİR. */
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Finansal işlem kayıtları için bkz. `@/domain/accounting` (LedgerEntry).
 * Eski `Transaction` / `TransactionInput` tipleri Sprint 1'de kaldırıldı:
 * miktar ve tutarlar artık ondalık dize, defter kaynak gerçek.
 */
