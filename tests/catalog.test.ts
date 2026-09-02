import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GOLD_PRODUCTS, getProduct, productsByCategory, requireProduct } from "@/domain/catalog";

/** Ürün kataloğunda bulunması zorunlu ürünler (gereksinim listesi). */
const REQUIRED_PRODUCTS = [
  "Gram Altın",
  "Has Altın",
  "24 Ayar Külçe",
  "Özel Gramajlı Külçe",
  "22 Ayar Bilezik",
  "18 Ayar Altın",
  "14 Ayar Altın",
  "8 Ayar Altın",
  "Yeni Çeyrek",
  "Eski Çeyrek",
  "Yeni Yarım",
  "Eski Yarım",
  "Yeni Tam",
  "Eski Tam",
  "Cumhuriyet Altını",
  "Ata Altın",
  "Reşat Altın",
  "Hamit Altın",
  "Gremse Altın",
  "İkibuçuk Altın",
  "Beşli Altın",
];

describe("altın ürün kataloğu", () => {
  it("gereksinim listesindeki tüm ürünleri içerir", () => {
    const names = GOLD_PRODUCTS.map((product) => product.name);
    for (const required of REQUIRED_PRODUCTS) {
      expect(names).toContain(required);
    }
  });

  it("ürün kimlikleri benzersizdir", () => {
    const ids = GOLD_PRODUCTS.map((product) => product.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has altın karşılığı milyem ile gram ağırlığın çarpımıdır", () => {
    for (const product of GOLD_PRODUCTS) {
      expect(product.pureGoldPerUnit).toBeCloseTo(product.milyem * product.gramWeight, 4);
    }
  });

  it("gram bazlı ürünlerin ağırlığı 1'dir, ziynet ürünleri adet ile takip edilir", () => {
    for (const product of GOLD_PRODUCTS) {
      if (product.unit === "gram") expect(product.gramWeight).toBe(1);
      if (product.category === "ziynet") expect(product.unit).toBe("adet");
    }
  });

  it("bilinmeyen ürün kimliği için net hata verir", () => {
    expect(getProduct("olmayan-urun")).toBeUndefined();
    expect(() => requireProduct("olmayan-urun")).toThrow(/Bilinmeyen altın ürünü/);
  });

  it("kategori grupları katalogdaki tüm ürünleri kapsar", () => {
    const grouped = productsByCategory().flatMap((group) => group.products);
    expect(grouped).toHaveLength(GOLD_PRODUCTS.length);
  });

  it("SQL referans dosyası katalogla aynı ürünleri içerir", () => {
    const sql = readFileSync("supabase/migrations/0003_seed_reference_data.sql", "utf8");
    for (const product of GOLD_PRODUCTS) {
      expect(sql).toContain(`'${product.id}'`);
    }
  });
});
