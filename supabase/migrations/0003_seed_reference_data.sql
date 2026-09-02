-- =============================================================================
-- Altın Takip — 0003 Referans veriler
--
-- BU DOSYA OTOMATİK ÜRETİLİR. Elle düzenlemeyin.
-- Kaynak: src/domain/catalog.ts  ve  src/prices/mock-provider.ts
-- Yeniden üretmek için: npm run db:catalog
-- =============================================================================

insert into public.gold_products
  (id, name, category, unit, milyem, gram_weight, pure_gold_per_unit, sort_order)
values
  ('gram-altin', 'Gram Altın', 'gram', 'gram', 0.995, 1, 0.995, 0),
  ('has-altin', 'Has Altın', 'gram', 'gram', 0.995, 1, 0.995, 1),
  ('kulce-24-ayar', '24 Ayar Külçe', 'kulce', 'gram', 0.999, 1, 0.999, 2),
  ('kulce-ozel-gramaj', 'Özel Gramajlı Külçe', 'kulce', 'gram', 0.999, 1, 0.999, 3),
  ('bilezik-22-ayar', '22 Ayar Bilezik', 'ayarli', 'gram', 0.916, 1, 0.916, 4),
  ('altin-18-ayar', '18 Ayar Altın', 'ayarli', 'gram', 0.75, 1, 0.75, 5),
  ('altin-14-ayar', '14 Ayar Altın', 'ayarli', 'gram', 0.585, 1, 0.585, 6),
  ('altin-8-ayar', '8 Ayar Altın', 'ayarli', 'gram', 0.333, 1, 0.333, 7),
  ('yeni-ceyrek', 'Yeni Çeyrek', 'ziynet', 'adet', 0.916, 1.75, 1.603, 8),
  ('eski-ceyrek', 'Eski Çeyrek', 'ziynet', 'adet', 0.916, 1.754, 1.6067, 9),
  ('yeni-yarim', 'Yeni Yarım', 'ziynet', 'adet', 0.916, 3.5, 3.206, 10),
  ('eski-yarim', 'Eski Yarım', 'ziynet', 'adet', 0.916, 3.508, 3.2133, 11),
  ('yeni-tam', 'Yeni Tam', 'ziynet', 'adet', 0.916, 7, 6.412, 12),
  ('eski-tam', 'Eski Tam', 'ziynet', 'adet', 0.916, 7.016, 6.4267, 13),
  ('cumhuriyet-altini', 'Cumhuriyet Altını', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 14),
  ('ata-altin', 'Ata Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 15),
  ('resat-altin', 'Reşat Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 16),
  ('hamit-altin', 'Hamit Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 17),
  ('ikibucuk-altin', 'İkibuçuk Altın', 'ziynet', 'adet', 0.916, 18.04, 16.5246, 18),
  ('besli-altin', 'Beşli Altın', 'ziynet', 'adet', 0.916, 36.08, 33.0493, 19),
  ('gremse-altin', 'Gremse Altın', 'ziynet', 'adet', 0.916, 36.08, 33.0493, 20)
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
    'mock',
    'Test Verisi',
    'TEST',
    false,
    'Bu fiyatlar test amaçlı üretilmiş örnek verilerdir. Gerçek piyasa fiyatı değildir, alım satım kararı için kullanılmamalıdır.',
    300
  )
on conflict (id) do update set
  label = excluded.label,
  market = excluded.market,
  is_real_market_data = excluded.is_real_market_data,
  disclaimer = excluded.disclaimer,
  stale_after_seconds = excluded.stale_after_seconds;
