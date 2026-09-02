import type { GoldProduct, MeasureUnit, ProductCategory } from "./types";

/**
 * Merkezi altın ürün kataloğu.
 *
 * Ürün listesi YALNIZCA burada tanımlanır; arayüz bileşenlerine dağıtılmaz.
 * Gram ağırlıkları ve milyem değerleri Türkiye kuyumculuk piyasasındaki
 * yaygın referans değerlerdir; bir fiyat sağlayıcısının verisi değildir.
 */

interface CatalogEntry {
  id: string;
  name: string;
  category: ProductCategory;
  unit: MeasureUnit;
  milyem: number;
  /** Adet ürünler için brüt gram; gram ürünlerde 1. */
  gramWeight: number;
}

const ENTRIES: readonly CatalogEntry[] = [
  // --- Gram bazlı ---
  { id: "gram-altin", name: "Gram Altın", category: "gram", unit: "gram", milyem: 0.995, gramWeight: 1 },
  { id: "has-altin", name: "Has Altın", category: "gram", unit: "gram", milyem: 0.995, gramWeight: 1 },

  // --- Külçe ---
  { id: "kulce-24-ayar", name: "24 Ayar Külçe", category: "kulce", unit: "gram", milyem: 0.999, gramWeight: 1 },
  { id: "kulce-ozel-gramaj", name: "Özel Gramajlı Külçe", category: "kulce", unit: "gram", milyem: 0.999, gramWeight: 1 },

  // --- Ayarlı takı / hurda ---
  { id: "bilezik-22-ayar", name: "22 Ayar Bilezik", category: "ayarli", unit: "gram", milyem: 0.916, gramWeight: 1 },
  { id: "altin-18-ayar", name: "18 Ayar Altın", category: "ayarli", unit: "gram", milyem: 0.75, gramWeight: 1 },
  { id: "altin-14-ayar", name: "14 Ayar Altın", category: "ayarli", unit: "gram", milyem: 0.585, gramWeight: 1 },
  { id: "altin-8-ayar", name: "8 Ayar Altın", category: "ayarli", unit: "gram", milyem: 0.333, gramWeight: 1 },

  // --- Ziynet (adet) ---
  { id: "yeni-ceyrek", name: "Yeni Çeyrek", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 1.75 },
  { id: "eski-ceyrek", name: "Eski Çeyrek", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 1.754 },
  { id: "yeni-yarim", name: "Yeni Yarım", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 3.5 },
  { id: "eski-yarim", name: "Eski Yarım", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 3.508 },
  { id: "yeni-tam", name: "Yeni Tam", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.0 },
  { id: "eski-tam", name: "Eski Tam", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.016 },
  { id: "cumhuriyet-altini", name: "Cumhuriyet Altını", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.216 },
  { id: "ata-altin", name: "Ata Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.216 },
  { id: "resat-altin", name: "Reşat Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.216 },
  { id: "hamit-altin", name: "Hamit Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 7.216 },
  { id: "ikibucuk-altin", name: "İkibuçuk Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 18.04 },
  { id: "besli-altin", name: "Beşli Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 36.08 },
  { id: "gremse-altin", name: "Gremse Altın", category: "ziynet", unit: "adet", milyem: 0.916, gramWeight: 36.08 },
];

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const GOLD_PRODUCTS: readonly GoldProduct[] = ENTRIES.map((entry, index) => ({
  ...entry,
  pureGoldPerUnit: round4(entry.milyem * entry.gramWeight),
  sortOrder: index,
}));

const BY_ID = new Map(GOLD_PRODUCTS.map((product) => [product.id, product]));

export function getProduct(productId: string): GoldProduct | undefined {
  return BY_ID.get(productId);
}

/** Katalogda olmayan bir kimlik gelirse erken ve net biçimde hata verir. */
export function requireProduct(productId: string): GoldProduct {
  const product = BY_ID.get(productId);
  if (!product) {
    throw new Error(`Bilinmeyen altın ürünü: ${productId}`);
  }
  return product;
}

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  gram: "Gram Altın",
  kulce: "Külçe",
  ayarli: "Ayarlı Altın",
  ziynet: "Ziynet Altın",
};

export const CATEGORY_ORDER: readonly ProductCategory[] = ["gram", "kulce", "ziynet", "ayarli"];

export function productsByCategory(): { category: ProductCategory; label: string; products: GoldProduct[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    products: GOLD_PRODUCTS.filter((product) => product.category === category),
  })).filter((group) => group.products.length > 0);
}
