/**
 * Ürün kataloğunu ve fiyat kaynağı tanımını SQL migration'ına yazar.
 *
 *   npm run db:catalog
 *
 * Katalog TEK KAYNAKTAN (src/domain/catalog.ts) yönetilir; bu betik SQL
 * kopyasının elle yazılmasından doğacak sapmayı önler.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GOLD_PRODUCTS } from "../src/domain/catalog";
import { MOCK_PROVIDER_META } from "../src/prices/mock-provider";

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/*
 * 0003 YALNIZCA ALTIN ÜRÜNLERİNİ İÇERİR.
 *
 * 0001'deki kısıtlar bu noktada hâlâ dardır: kategori yalnız
 * (gram, kulce, ziynet, ayarli) olabilir ve `milyem > 0` şarttır. Gümüş ve
 * döviz bu kısıtlara UYMAZ (milyem 0). Migration'lar sırayla koştuğu için
 * 0003'e eklenirlerse temiz kurulum 0001'den hemen sonra patlar.
 *
 * Bu yüzden altın olmayan ürünler kısıtları genişleten kendi migration'ında
 * (0026) eklenir. Katalog yine TEK KAYNAKTAN yönetilir; burada yalnızca
 * tarihsel sıra korunur.
 */
const LEGACY_CATEGORIES = ["gram", "kulce", "ziynet", "ayarli"];

const productRows = GOLD_PRODUCTS.filter((product) =>
  LEGACY_CATEGORIES.includes(product.category),
).map(
  (product) =>
    `  (${quote(product.id)}, ${quote(product.name)}, ${quote(product.category)}, ` +
    `${quote(product.unit)}, ${product.milyem}, ${product.gramWeight}, ` +
    `${product.pureGoldPerUnit}, ${product.sortOrder})`,
).join(",\n");

const sql = `-- =============================================================================
-- Altın Takip — 0003 Referans veriler
--
-- BU DOSYA OTOMATİK ÜRETİLİR. Elle düzenlemeyin.
-- Kaynak: src/domain/catalog.ts  ve  src/prices/mock-provider.ts
-- Yeniden üretmek için: npm run db:catalog
-- =============================================================================

insert into public.gold_products
  (id, name, category, unit, milyem, gram_weight, pure_gold_per_unit, sort_order)
values
${productRows}
on conflict (id) do update set
  name = excluded.name,
  category = excluded.category,
  unit = excluded.unit,
  milyem = excluded.milyem,
  gram_weight = excluded.gram_weight,
  pure_gold_per_unit = excluded.pure_gold_per_unit,
  sort_order = excluded.sort_order;

-- Fiyat kaynağı. is_real_market_data = false olduğu sürece arayüz bu veriyi
-- "Test Verisi" olarak etiketlemek ZORUNDADIR.
insert into public.price_sources
  (id, label, market, is_real_market_data, disclaimer, stale_after_seconds)
values
  (
    ${quote(MOCK_PROVIDER_META.id)},
    ${quote(MOCK_PROVIDER_META.label)},
    ${quote(MOCK_PROVIDER_META.market)},
    false,
    ${quote(MOCK_PROVIDER_META.disclaimer)},
    ${Math.round(MOCK_PROVIDER_META.staleAfterMs / 1000)}
  )
on conflict (id) do update set
  label = excluded.label,
  market = excluded.market,
  is_real_market_data = excluded.is_real_market_data,
  disclaimer = excluded.disclaimer,
  stale_after_seconds = excluded.stale_after_seconds;
`;

const target = resolve(process.cwd(), "supabase/migrations/0003_seed_reference_data.sql");
writeFileSync(target, sql, "utf8");
console.log(`Yazıldı: ${target} (${GOLD_PRODUCTS.length} ürün)`);
