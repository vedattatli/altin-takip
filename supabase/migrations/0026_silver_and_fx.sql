-- =============================================================================
-- 0026 — GÜMÜŞ VE DÖVİZ ÜRÜNLERİ EKLENDİ
--
-- Kullanıcı isteği: gümüş, dolar ve euro da takip edilebilsin.
--
-- BUNLAR ALTIN DEĞİLDİR ve öyle sayılmazlar. `milyem = 0` oldukları için
-- `pure_gold_per_unit` da 0'dır; portföyün "has altın" gramına KATILMAZLAR.
-- Portföy DEĞERİNE ise girerler. Bu bir gösterim tercihi değil DOĞRULUK
-- meselesidir: gümüşü veya doları has altın gramına eklemek "108 gr has altın"
-- satırını yalan hâle getirirdi.
--
-- Döviz "adet" birimiyle tutulur: 1 adet = 1 birim para (1 USD, 1 EUR).
--
-- Fiyat kaynakları (ölçüldü, 2026-09-04):
--   gumus-gram  Kapalıçarşı "Gümüş Gram"  96,79 / 103,94  (bayi makası ~%7)
--   usd         Trunçgil "USD"            48,44 / 48,44   (referans kuru)
--   eur         Trunçgil "EUR"            56,30 / 56,31   (referans kuru)
--
-- Döviz makası çok dardır çünkü bunlar PİYASA REFERANS KURUDUR; bir bankanın
-- veya döviz bürosunun tezgâh fiyatı DEĞİLDİR.
--
-- NEDEN KISITLAR GENİŞLETİLİYOR: 0001'deki kısıtlar yalnızca altın için
-- yazılmıştı (kategori dört değerle sınırlı, `milyem > 0`). Altın olmayan
-- varlıklar bunlara uymaz. 0003 bu yüzden altınla SINIRLI kalır; yeni ürünler
-- burada, kısıtlar genişletildikten SONRA eklenir. Migration'lar sırayla
-- koştuğu için tersi mümkün değildir.
-- =============================================================================

alter table public.gold_products
  drop constraint if exists gold_products_category_check;

alter table public.gold_products
  add constraint gold_products_category_check
  check (category in ('gram', 'kulce', 'ziynet', 'ayarli', 'gumus', 'doviz'));

-- Altın ürünlerde hâlâ 0 < milyem <= 1 beklenir; kural kategoriye bağlandı ki
-- bir altın ürününe yanlışlıkla milyem 0 yazılamasın.
alter table public.gold_products
  drop constraint if exists gold_products_milyem_check;

alter table public.gold_products
  add constraint gold_products_milyem_check
  check (
    case
      when category in ('gumus', 'doviz') then milyem = 0
      else milyem > 0 and milyem <= 1
    end
  );

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
  ('gremse-altin', 'Gremse Altın', 'ziynet', 'adet', 0.916, 36.08, 33.0493, 21),
  ('gumus-gram', 'Gram Gümüş', 'gumus', 'gram', 0, 1, 0, 22),
  ('usd', 'Amerikan Doları', 'doviz', 'adet', 0, 0, 0, 23),
  ('eur', 'Euro', 'doviz', 'adet', 0, 0, 0, 24)
on conflict (id) do update set
  name = excluded.name,
  category = excluded.category,
  unit = excluded.unit,
  milyem = excluded.milyem,
  gram_weight = excluded.gram_weight,
  pure_gold_per_unit = excluded.pure_gold_per_unit,
  sort_order = excluded.sort_order;
