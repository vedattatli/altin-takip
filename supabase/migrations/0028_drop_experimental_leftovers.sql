-- =============================================================================
-- 0028 — DENEYSEL KAYNAK KALINTILARI TEMİZLENDİ
--
-- 0023 "deneysel kaynak kapısı kaldırıldı" dedi ve `price_providers` üzerindeki
-- KISITI düşürdü. Ama aynı kuralı uygulayan ÜÇ RPC olduğu gibi kaldı; kapı
-- kapalı kalmaya devam etti:
--
--  1. price_providers_sync
--     Katalog her eşitlendiğinde (yönetim sayfası her açılışta çağırıyor)
--     `user_selectable` alanını LICENSED/DEV_ONLY dışındaki her kaynak için
--     SESSİZCE false'a çekiyordu. Yönetici kaynağı kullanıcıya açsa bile bir
--     sonraki eşitlemede kapanıyordu — sebebi ekranda görünmeyen bir geri alma.
--
--  2. price_provider_set_flags
--     EXPERIMENTAL_PRIVATE bir kaynağı kullanıcı listesine açma denemesini
--     hata ile reddediyordu. Yönetici düğmeye basıyor, "genel listeye açılamaz"
--     hatası alıyordu.
--
--  3. price_preference_set
--     `user_selectable` olmayan kaynağı yalnızca "yönetici onaylı izin
--     listesi" varsa seçtiriyordu. O izin listesi ürün kararıyla kaldırıldı;
--     dolayısıyla dal artık hiçbir zaman doğru olamıyordu.
--
-- Bu migration üç fonksiyonu da kuralın 0023'te söylenen hâline getirir:
-- LİSANS DURUMU ERİŞİMİ BELİRLEMEZ. Lisans durumu ayrı bir alandır, arayüzde
-- açıkça gösterilir ve kaynağın lisanssız olduğu yazılmaya devam eder.
--
-- KORUNAN KURALLAR (gevşetilmedi):
--   * Lisansı/yapılandırması olmayan kaynak ETKİNLEŞTİRİLEMEZ.
--   * LICENSED bir kaynak yeniden gösterim izni yoksa etkinleştirilemez.
--   * Kapalı kaynak kullanıcıya sunulamaz.
--   * REFERENCE_ONLY kaynağı değerleme için seçilemez.
--
-- AYRICA: `experimental_access_*` fonksiyonları düşürülür. Onları çağıran tek
-- yer price_preference_set'ti; o dal kalktığı için fonksiyonlar da gider.
-- `experimental_price_access` TABLOSU DURUR: geçmiş denetim kaydıdır, veri
-- silmek geriye dönük izlenebilirliği bozar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Katalog eşitlemesi kullanıcı seçilebilirliğini geri almasın
-- -----------------------------------------------------------------------------

create or replace function public.price_providers_sync(p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  affected integer := 0;
begin
  if jsonb_typeof(p_payload) <> 'array' then
    raise exception 'Sağlayıcı listesi dizi olmalıdır.' using errcode = 'P0004';
  end if;

  for item in select * from jsonb_array_elements(p_payload)
  loop
    insert into public.price_providers as pp
      (code, display_name, technical_name, market_id, market_display_name, provider_type,
       license_status, license_reference, redistribution_allowed, capabilities, attribution, reference_url)
    values
      (item->>'code',
       item->>'displayName',
       coalesce(item->>'technicalName', ''),
       item->>'marketId',
       coalesce(item->>'marketDisplayName', ''),
       item->>'providerType',
       coalesce(item->>'licenseStatus', 'NOT_CONFIGURED'),
       nullif(item->>'licenseReference', ''),
       coalesce((item->>'redistributionAllowed')::boolean, false),
       coalesce(item->'capabilities', '[]'::jsonb),
       coalesce(item->>'attribution', ''),
       nullif(item->>'referenceUrl', ''))
    on conflict (code) do update set
      display_name = excluded.display_name,
      technical_name = excluded.technical_name,
      market_id = excluded.market_id,
      market_display_name = excluded.market_display_name,
      provider_type = excluded.provider_type,
      license_status = excluded.license_status,
      license_reference = excluded.license_reference,
      redistribution_allowed = excluded.redistribution_allowed,
      capabilities = excluded.capabilities,
      attribution = excluded.attribution,
      reference_url = excluded.reference_url,
      -- Lisans kaybedildiyse kaynak otomatik devre dışı kalır (fail closed).
      enabled = pp.enabled
        and excluded.license_status in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE'),
      -- Kullanıcı seçilebilirliği YÖNETİCİNİN kararıdır; eşitleme onu geri almaz.
      -- Yalnızca kapanan bir kaynak listeden de düşer.
      user_selectable = pp.user_selectable
        and pp.enabled
        and excluded.license_status in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE'),
      updated_at = now();
    affected := affected + 1;
  end loop;

  return affected;
end;
$$;

revoke all on function public.price_providers_sync(jsonb) from public, anon, authenticated;
grant execute on function public.price_providers_sync(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 2. Yönetici bayrakları: lisans durumu kullanıcı listesini engellemesin
-- -----------------------------------------------------------------------------

create or replace function public.price_provider_set_flags(
  p_code text,
  p_enabled boolean,
  p_user_selectable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.price_providers;
begin
  select * into row_data from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;

  if p_enabled and row_data.license_status not in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE') then
    raise exception 'ALTIN_PROVIDER_LICENSE_REQUIRED: % kaynağı lisans/izin olmadan etkinleştirilemez.', p_code
      using errcode = 'P0006';
  end if;
  if p_enabled and row_data.license_status = 'LICENSED' and not row_data.redistribution_allowed then
    raise exception 'ALTIN_PROVIDER_LICENSE_REQUIRED: % kaynağı için yeniden gösterim izni işaretlenmemiş.', p_code
      using errcode = 'P0006';
  end if;
  if p_user_selectable and not p_enabled then
    raise exception 'Kapalı bir kaynak kullanıcıya sunulamaz.' using errcode = 'P0004';
  end if;

  update public.price_providers
  set enabled = p_enabled,
      user_selectable = p_user_selectable,
      updated_at = now()
  where code = p_code
  returning * into row_data;

  return to_jsonb(row_data);
end;
$$;

revoke all on function public.price_provider_set_flags(text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.price_provider_set_flags(text, boolean, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Kaynak seçimi: deneysel izin listesi dalı kaldırıldı
--
-- Kural sadeleşti: kullanıcı yalnızca kendisine AÇILMIŞ bir kaynağı seçebilir.
-- İkinci bir "izin listesi" kapısı yok.
-- -----------------------------------------------------------------------------

create or replace function public.price_preference_set(
  p_user_id uuid,
  p_code text,
  p_actor uuid,
  p_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pf public.portfolios;
  target public.price_providers;
  previous public.portfolio_price_preferences;
  previous_code text;
  previous_market text;
begin
  if p_role not in ('user', 'admin') then
    raise exception 'Geçersiz aktör rolü.' using errcode = 'P0004';
  end if;

  select * into pf from public.portfolios where user_id = p_user_id;
  if not found then
    raise exception 'ALTIN_PORTFOLIO_NOT_PROVISIONED: % kullanıcısının portföyü yok.', p_user_id
      using errcode = 'P0002';
  end if;

  select * into target from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  if not target.enabled then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE: % kaynağı kullanıma kapalı.', p_code using errcode = 'P0006';
  end if;
  if p_role = 'user' and not target.user_selectable then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE: % kaynağı kullanıcı seçimine kapalı.', p_code
      using errcode = 'P0006';
  end if;
  if target.capabilities ? 'REFERENCE_ONLY' then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE: referans kaynağı değerleme için seçilemez.'
      using errcode = 'P0006';
  end if;

  select * into previous from public.portfolio_price_preferences where portfolio_id = pf.id;
  if found and previous.selected_provider_id is not null then
    select code, market_id into previous_code, previous_market
    from public.price_providers where id = previous.selected_provider_id;
  end if;

  insert into public.portfolio_price_preferences as pref
    (portfolio_id, user_id, selected_provider_id, selected_market_id, selected_at, selected_by, updated_at)
  values (pf.id, p_user_id, target.id, target.market_id, now(), p_actor, now())
  on conflict (portfolio_id) do update set
    selected_provider_id = excluded.selected_provider_id,
    selected_market_id = excluded.selected_market_id,
    selected_at = now(),
    selected_by = excluded.selected_by,
    updated_at = now();

  -- Denetim izi: gerçek değişiklikte kayıt üretilir.
  if previous_code is distinct from target.code then
    insert into public.price_source_change_events
      (portfolio_id, user_id, previous_provider_id, new_provider_id, previous_market_id, new_market_id,
       changed_by, changed_by_role, reason)
    values
      (pf.id, p_user_id, previous.selected_provider_id, target.id, previous_market, target.market_id,
       p_actor, p_role, left(coalesce(p_reason, ''), 200));
  end if;

  return jsonb_build_object(
    'portfolioId', pf.id,
    'providerCode', target.code,
    'marketId', target.market_id,
    'previousProviderCode', previous_code,
    'changed', previous_code is distinct from target.code);
end;
$$;

revoke all on function public.price_preference_set(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.price_preference_set(uuid, text, uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Deneysel izin listesi fonksiyonları düşürülür
--
-- Tabloya artık hiçbir yerden yazılmıyor ve fiyat yolunda okunmuyor.
-- Tablo geçmiş kayıt olarak DURUR; veri silinmez.
-- -----------------------------------------------------------------------------

drop function if exists public.experimental_access_set(uuid, text, boolean, uuid, text, timestamptz);
drop function if exists public.experimental_access_allowed(uuid, text);
drop function if exists public.experimental_access_list(text);

comment on table public.experimental_price_access is
  'KULLANIM DIŞI. Kullanıcı bazlı deneysel kaynak izin listesi kaldırıldı (0023, 0028). '
  'Tablo geçmiş denetim kaydı olarak durur; yazan veya okuyan bir yol yoktur.';

-- -----------------------------------------------------------------------------
-- 5. Denetim eylemi adı: "deneysel erişim" yerine "ekran worker durumu"
--
-- Geriye kalan tek çağrı worker durumunun OKUNMASIDIR; onu "deneysel erişim"
-- diye kaydetmek denetim kaydını yanlış adlandırıyordu. Eski değer listede
-- KALIR: geçmiş kayıtlar değiştirilemez.
-- -----------------------------------------------------------------------------

alter table public.admin_audit_logs
  drop constraint if exists admin_audit_logs_action_check;

alter table public.admin_audit_logs
  add constraint admin_audit_logs_action_check check (
    action in (
      'user.create', 'user.deactivate', 'user.activate', 'user.password_reset',
      'user.view', 'user.portfolio_view', 'user.account_view',
      'user.sessions_view', 'user.sessions_revoke',
      'user.delete_attempt', 'user.delete',
      'mfa.enroll', 'mfa.verify', 'mfa.reset', 'mfa.recovery_used',
      'price.provider_update', 'price.source_change', 'price.refresh',
      'price.quarantine_view', 'price.default_source',
      -- Worker bir yönetici DEĞİLDİR: yazmalarının izi price_ingestion_runs'tadır,
      -- yönetici denetim kaydında değil.
      'price.screen_worker', 'price.mapping_approve',
      -- Artık ÜRETİLMEYEN eylemler; geçmiş kayıtlar için listede kalır.
      'price.experimental_access',
      'data.export', 'data.deletion_request'
    )
  );

comment on constraint admin_audit_logs_action_check on public.admin_audit_logs is
  'Denetim eylemleri kapalı listedir. user.portfolio_view ve price.experimental_access '
  'artık üretilmez ama geçmiş kayıtlar için listede kalır; denetim kaydı değiştirilemez.';
