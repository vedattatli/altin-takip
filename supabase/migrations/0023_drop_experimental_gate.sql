-- =============================================================================
-- 0023 — DENEYSEL KAYNAK KAPISI KALDIRILDI
--
-- ÜRÜN KARARI (sahibi tarafından verildi): uygulama kapalı bir kişisel pilottur.
-- Hesapları yalnızca yönetici açar, herkese açık kayıt ucu yoktur. Bu yüzden
-- "deneysel kaynak" ayrımı ve ona bağlı ikinci kapı katmanı kaldırıldı.
--
-- KALDIRILAN: `price_providers_experimental_not_public` kısıtı. Bu kısıt
-- lisanssız kaynağın `user_selectable` olmasını engelliyordu; sonucunda kaynak
-- yönetim ekranından açılamıyor, kullanıcı listesinde görünmüyor ve ürünler
-- SESSİZCE fiyatsız kalıyordu. Üretimde tam olarak bu yaşandı.
--
-- KALDIRILMAYAN (bilerek):
--   * `price_providers_enabled_requires_license` — lisanssız/yapılandırılmamış
--     kaynak hâlâ etkinleştirilemez. Kapı gevşetilmedi, yalnızca DENEYSEL
--     ayrımı kalktı.
--   * `experimental_source_access` tablosu — geçmiş kayıt olarak durur; artık
--     fiyat yolunda OKUNMAZ. Veri silmek geriye dönük denetimi bozar.
--
-- DÜRÜSTLÜK NOTU: veri hâlâ LİSANSLI DEĞİLDİR. Kaldırılan şey erişim
-- sürtünmesidir, lisans beyanı değil. `license_status` alanı olduğu gibi kalır
-- ve arayüz kaynağın lisanssız olduğunu yazmaya devam eder.
-- =============================================================================

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'price_providers_experimental_not_public'
      and conrelid = 'public.price_providers'::regclass
  ) then
    alter table public.price_providers
      drop constraint price_providers_experimental_not_public;
  end if;
end;
$$;

comment on column public.price_providers.user_selectable is
  'Kullanıcı bu kaynağı kendi portföyü için seçebilir mi? Lisanssız kaynaklar da '
  'seçilebilir; lisans durumu ayrı bir alandır ve arayüzde açıkça gösterilir.';
