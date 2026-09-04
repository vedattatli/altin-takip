import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { valuePositions } from "@/domain/accounting";
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

  /*
   * 0003 YALNIZCA ALTIN ürünlerini içerir; 0001'deki kısıtlar o noktada hâlâ
   * dardır (kategori dört değer, milyem > 0). Gümüş ve döviz kısıtları
   * genişleten 0026'da eklenir. Katalogdaki HER ürün ikisinden birinde
   * bulunmak ZORUNDADIR: aksi hâlde temiz kurulumda ürün eksik kalır.
   */
  it("katalogdaki her ürün bir migration'da seed edilir", () => {
    const seed = readFileSync("supabase/migrations/0003_seed_reference_data.sql", "utf8");
    const nonGold = readFileSync("supabase/migrations/0026_silver_and_fx.sql", "utf8");
    for (const product of GOLD_PRODUCTS) {
      const found = seed.includes(`'${product.id}'`) || nonGold.includes(`'${product.id}'`);
      expect(found, product.id).toBe(true);
    }
  });

  it("altın olmayan ürün 0003'e SIZMAZ (kısıtlar oraya izin vermez)", () => {
    const seed = readFileSync("supabase/migrations/0003_seed_reference_data.sql", "utf8");
    for (const id of ["gumus-gram", "usd", "eur"]) {
      expect(seed.includes(`'${id}'`), id).toBe(false);
    }
  });
});

/**
 * ALTIN OLMAYAN VARLIKLAR — GÜMÜŞ VE DÖVİZ
 *
 * Bunlar portföy DEĞERİNE girer ama "has altın" gramına GİRMEZ. Bu bir
 * gösterim tercihi değil DOĞRULUK meselesidir: gümüşü veya doları has altın
 * gramına eklemek, "108 gr has altın" satırını yalan hâle getirirdi.
 */
describe("altın olmayan varlıklar", () => {
  const NON_GOLD = ["gumus-gram", "usd", "eur"];

  it("saf altın karşılıkları SIFIRDIR", () => {
    for (const id of NON_GOLD) {
      const product = getProduct(id);
      expect(product, id).toBeDefined();
      expect(product?.pureGoldPerUnit, id).toBe(0);
      expect(product?.milyem, id).toBe(0);
    }
  });

  it("has altın toplamına KATILMAZLAR", () => {
    const positions = NON_GOLD.map((productId) => ({
      productId,
      quantity: "100",
      remainingCostBasis: "10000",
      averageCost: "100",
      realizedPnl: "0",
      holdingCostOrigins: { actual: true, estimated: false, baseline: false },
      realizedPnlOrigins: { actual: false, estimated: false, baseline: false },
      activeTransactionCount: 1,
      lastLedgerSequence: 1,
    }));
    const summary = valuePositions(positions, null, Date.now());
    // Elde varlık var ama saf altın SIFIR.
    expect(summary.totalPureGoldGrams).toBe("0");
  });

  it("altın ürünleri bu listeye karışmaz", () => {
    for (const product of GOLD_PRODUCTS) {
      if (NON_GOLD.includes(product.id)) continue;
      expect(product.pureGoldPerUnit, product.id).toBeGreaterThan(0);
    }
  });

  /*
   * BÖLÜNEBİLİRLİK BİRİMDEN OKUNAMAZ.
   *
   * "adet" birimi iki farklı şeyi taşır: bölünemeyen ziynet altını ve
   * bölünebilen döviz. Kural bir zamanlayken `unit === "adet"` idi ve döviz
   * eklenince kullanıcı 1.500,50 dolar giremez oldu.
   */
  it("döviz bölünebilir, ziynet altını bölünemez", () => {
    expect(getProduct("usd")?.quantityScale).toBe(2);
    expect(getProduct("eur")?.quantityScale).toBe(2);
    expect(getProduct("gumus-gram")?.quantityScale).toBe(6);

    for (const product of GOLD_PRODUCTS) {
      if (product.category === "ziynet") expect(product.quantityScale, product.id).toBe(0);
      if (product.unit === "gram") expect(product.quantityScale, product.id).toBe(6);
    }
  });

  /*
   * Veritabanı tetikleyicisi (0027) ile TypeScript tablosu birlikte
   * değişmelidir; biri gevşer diğeri kalırsa kullanıcı formda kabul edilen
   * miktarı kaydedemez.
   */
  it("veritabanı tetikleyicisi aynı ondalık tablosunu uygular", () => {
    const migration = readFileSync("supabase/migrations/0027_quantity_scale_by_product.sql", "utf8");
    expect(migration).toMatch(/when 'ziynet' then 0/);
    expect(migration).toMatch(/when 'doviz' then 2/);
    expect(migration).toMatch(/else 6/);
  });
});
