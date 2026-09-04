-- =============================================================================
-- 0027 — MİKTAR ONDALIK SINIRI BİRİME DEĞİL ÜRÜNE BAĞLANDI
--
-- HATA: 0005'teki tetikleyici "birim adet ise miktar tam sayı olmalı" diyordu.
-- Katalogda yalnızca ziynet altını "adet" iken bu doğruydu. Dolar ve euro
-- eklendiğinde ikisi de "adet" birimiyle tutuldu ve kural onlara da uygulandı:
-- kullanıcı 1.500,50 dolar KAYDEDEMİYORDU. Bakiyesini ya yuvarlamak ya da
-- eksik girmek zorundaydı.
--
-- DOĞRU KURAL: bölünebilirlik birimin değil ÜRÜNÜN özelliğidir.
--   ziynet  → 0 ondalık (yarım çeyrek altın diye bir şey yoktur)
--   doviz   → 2 ondalık (kuruş hassasiyeti yeter)
--   diğeri  → 6 ondalık (gram altın, külçe, ayarlı, gümüş)
--
-- Aynı tablo TypeScript tarafında `QUANTITY_SCALE_BY_CATEGORY` (src/domain/
-- catalog.ts) içindedir. İkisi birlikte değişmelidir.
--
-- Birim tutarlılığı denetimi (işlemin birimi katalog birimiyle aynı olmalı)
-- AYNEN korunur; yalnızca ondalık kuralı değişti.
--
-- GERİYE DÖNÜK: mevcut kayıtlar zaten daha dar bir kurala uyuyordu; bu
-- migration hiçbir kaydı geçersiz kılmaz, yalnızca yeni girişleri serbest
-- bırakır.
-- =============================================================================

create or replace function public.enforce_transaction_unit()
returns trigger
language plpgsql
as $$
declare
  catalog_unit text;
  catalog_category text;
  max_scale int;
begin
  select unit, category into catalog_unit, catalog_category
  from public.gold_products
  where id = new.product_id;

  if catalog_unit is null then
    raise exception 'Bilinmeyen ürün: %', new.product_id using errcode = '23514';
  end if;

  if new.unit is distinct from catalog_unit then
    raise exception 'Ürün birimi uyuşmuyor: % için birim % olmalıdır.', new.product_id, catalog_unit
      using errcode = '23514';
  end if;

  max_scale := case catalog_category
    when 'ziynet' then 0
    when 'doviz' then 2
    else 6
  end;

  if new.quantity <> round(new.quantity, max_scale) then
    if max_scale = 0 then
      raise exception 'Bu ürün adet ile takip edilir; miktar tam sayı olmalıdır.'
        using errcode = '23514';
    else
      raise exception 'Bu üründe miktar en fazla % ondalık basamak olabilir.', max_scale
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_transaction_unit() is
  'İşlemin birimi katalog birimiyle aynı olmalıdır; miktar ondalık sınırı ürün kategorisinden gelir (ziynet 0, döviz 2, diğer 6).';
