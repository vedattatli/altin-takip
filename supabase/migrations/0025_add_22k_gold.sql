-- =============================================================================
-- 0025 — KATALOĞA "22 AYAR ALTIN" EKLENDİ
--
-- Katalogda yalnızca "22 Ayar Bilezik" vardı. İkisi AYRI ürünlerdir ve ayrı
-- kalır: 22 ayar gram altın (hurda/külçe niteliğinde) piyasada iki yönlü
-- fiyatlanır; bilezik aynı ayarda olsa da İŞÇİLİK payı taşır ve aynı fiyattan
-- alınıp satılmaz. Bileziği hurda fiyatıyla değerlemek yanlış olurdu.
--
-- Ölçüm (2026-09-04, Kapalıçarşı tablosu): "22 Ayar Altın" 6279.18 / 6492.15,
-- makas ~%3,4. Gram altın 6868 × 0,916 = 6291 TL saf altın karşılığı; alış
-- bunun hemen altında, satış üstünde. Yani bu satır GERÇEK bir alış/satış
-- makasıdır (14 ayar satırındaki %32'lik hurda-alış / perakende-satış
-- karışıklığı burada YOKTUR).
--
-- NEDEN AYRI MIGRATION: 0003 otomatik üretilir ve yalnızca temiz kurulumda
-- çalışır; zaten uygulanmış veritabanları yeni ürünü ancak buradan alır.
--
-- NEDEN KATALOĞUN TAMAMI: yeni ürün 4. sıraya girdiği için SONRAKİ bütün
-- ürünlerin sort_order değeri kaydı. Tek satır eklemek veritabanını kaynak
-- kodundaki katalogdan sessizce saptırırdı. Blok idempotenttir ve
-- src/domain/catalog.ts'ten üretilmiştir (npm run db:catalog).
-- =============================================================================

insert into public.gold_products
  (id, name, category, unit, milyem, gram_weight, pure_gold_per_unit, sort_order)
values
  ('gram-altin', 'Gram Altın', 'gram', 'gram', 0.995, 1, 0.995, 0),
  ('has-altin', 'Has Altın', 'gram', 'gram', 0.995, 1, 0.995, 1),
  ('kulce-24-ayar', '24 Ayar Külçe', 'kulce', 'gram', 0.999, 1, 0.999, 2),
  ('kulce-ozel-gramaj', 'Özel Gramajlı Külçe', 'kulce', 'gram', 0.999, 1, 0.999, 3),
  ('altin-22-ayar', '22 Ayar Altın', 'ayarli', 'gram', 0.916, 1, 0.916, 4),
  ('bilezik-22-ayar', '22 Ayar Bilezik', 'ayarli', 'gram', 0.916, 1, 0.916, 5),
  ('altin-18-ayar', '18 Ayar Altın', 'ayarli', 'gram', 0.75, 1, 0.75, 6),
  ('altin-14-ayar', '14 Ayar Altın', 'ayarli', 'gram', 0.585, 1, 0.585, 7),
  ('altin-8-ayar', '8 Ayar Altın', 'ayarli', 'gram', 0.333, 1, 0.333, 8),
  ('yeni-ceyrek', 'Yeni Çeyrek', 'ziynet', 'adet', 0.916, 1.75, 1.603, 9),
  ('eski-ceyrek', 'Eski Çeyrek', 'ziynet', 'adet', 0.916, 1.754, 1.6067, 10),
  ('yeni-yarim', 'Yeni Yarım', 'ziynet', 'adet', 0.916, 3.5, 3.206, 11),
  ('eski-yarim', 'Eski Yarım', 'ziynet', 'adet', 0.916, 3.508, 3.2133, 12),
  ('yeni-tam', 'Yeni Tam', 'ziynet', 'adet', 0.916, 7, 6.412, 13),
  ('eski-tam', 'Eski Tam', 'ziynet', 'adet', 0.916, 7.016, 6.4267, 14),
  ('cumhuriyet-altini', 'Cumhuriyet Altını', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 15),
  ('ata-altin', 'Ata Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 16),
  ('resat-altin', 'Reşat Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 17),
  ('hamit-altin', 'Hamit Altın', 'ziynet', 'adet', 0.916, 7.216, 6.6099, 18),
  ('ikibucuk-altin', 'İkibuçuk Altın', 'ziynet', 'adet', 0.916, 18.04, 16.5246, 19),
  ('besli-altin', 'Beşli Altın', 'ziynet', 'adet', 0.916, 36.08, 33.0493, 20),
  ('gremse-altin', 'Gremse Altın', 'ziynet', 'adet', 0.916, 36.08, 33.0493, 21)
on conflict (id) do update set
  name = excluded.name,
  category = excluded.category,
  unit = excluded.unit,
  milyem = excluded.milyem,
  gram_weight = excluded.gram_weight,
  pure_gold_per_unit = excluded.pure_gold_per_unit,
  sort_order = excluded.sort_order;
