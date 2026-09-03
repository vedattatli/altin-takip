-- =============================================================================
-- 0016 — FİYAT ÇALIŞMA ZAMANI BÜTÜNLÜĞÜ (Sprint 3.1)
--
-- 1. Karantinaya alınan fiyatlar KALICI ve DEĞİŞTİRİLEMEZ biçimde saklanır.
--    Önceden yalnızca "kaç adet" sayısı tutuluyordu; hangi ürünün hangi sebeple
--    reddedildiği araştırılamıyordu.
-- 2. Ingestion RPC'si veritabanı seviyesinde sertleştirilir: sağlayıcı durumu,
--    para birimi, fiyat işareti, makas yönü, zaman damgası, katalog üyeliği ve
--    aynı koşumda yinelenen kanonik ürün burada da denetlenir.
-- 3. Açık GLOBAL VARSAYILAN kaynak: "listedeki ilk açık kaynak" davranışı yerine
--    yöneticinin seçtiği tek bir varsayılan.
-- 4. Yönetici TOTP replay koruması için son kullanılan sayaç.
--
-- Ham payload, adres, anahtar veya kişisel veri HİÇBİR tabloda saklanmaz.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Karantina tablosu (append-only)
-- -----------------------------------------------------------------------------

create table if not exists public.price_quote_quarantine (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid references public.price_ingestion_runs (id) on delete cascade,
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  market_id text not null,
  canonical_product_id text not null,
  rejection_code text not null,
  -- Reddedilen değerler tanı için saklanır; DEĞERLEMEYE ASLA girmez.
  liquidation_price numeric(20, 8),
  replacement_price numeric(20, 8),
  currency text,
  provider_timestamp timestamptz,
  fetched_at timestamptz,
  mapping_version text,
  -- Ham yanıt saklanmaz; yalnızca özeti tutulur.
  raw_payload_hash text,
  created_at timestamptz not null default now()
);

create index if not exists price_quote_quarantine_provider_idx
  on public.price_quote_quarantine (provider_id, created_at desc);
create index if not exists price_quote_quarantine_run_idx
  on public.price_quote_quarantine (ingestion_run_id);
create index if not exists price_quote_quarantine_product_idx
  on public.price_quote_quarantine (canonical_product_id, created_at desc);

alter table public.price_quote_quarantine enable row level security;
alter table public.price_quote_quarantine force row level security;

-- Data API'ye kapalı: hiçbir istemci rolü okuyamaz veya yazamaz.
revoke all on table public.price_quote_quarantine from public, anon, authenticated;
revoke all on table public.price_quote_quarantine from service_role;
grant select on table public.price_quote_quarantine to service_role;

-- Append-only: yalnızca kontrollü RPC ekler, kimse güncelleyemez/silemez.
create or replace function public.reject_price_quarantine_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Karantina kayıtları değiştirilemez veya silinemez.' using errcode = '42501';
end;
$$;

revoke all on function public.reject_price_quarantine_mutation() from public, anon, authenticated, service_role;

drop trigger if exists price_quote_quarantine_no_update on public.price_quote_quarantine;
create trigger price_quote_quarantine_no_update
  before update on public.price_quote_quarantine
  for each row execute function public.reject_price_quarantine_mutation();

drop trigger if exists price_quote_quarantine_no_delete on public.price_quote_quarantine;
create trigger price_quote_quarantine_no_delete
  before delete on public.price_quote_quarantine
  for each row execute function public.reject_price_quarantine_mutation();

-- -----------------------------------------------------------------------------
-- 2. Global varsayılan kaynak
-- -----------------------------------------------------------------------------

alter table public.price_providers
  add column if not exists is_default boolean not null default false;

-- En fazla BİR varsayılan olabilir.
create unique index if not exists price_providers_single_default_idx
  on public.price_providers ((true)) where is_default;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'price_providers_default_requires_enabled'
      and conrelid = 'public.price_providers'::regclass
  ) then
    alter table public.price_providers
      add constraint price_providers_default_requires_enabled
      check (not is_default or (enabled and user_selectable));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Yönetici TOTP replay koruması
-- -----------------------------------------------------------------------------

alter table public.admin_mfa_credentials
  add column if not exists last_used_counter bigint;

-- -----------------------------------------------------------------------------
-- 4. Sertleştirilmiş ingestion
-- -----------------------------------------------------------------------------

create or replace function public.price_ingestion_apply(p_code text, p_run_key text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  provider_row public.price_providers;
  run_id uuid;
  existing_run public.price_ingestion_runs;
  item jsonb;
  v_quote_count integer := 0;
  v_rejected integer := 0;
  v_stale_count integer := 0;
  v_status text;
  v_fetched timestamptz;
  v_reference boolean;
  v_product text;
  v_liquidation numeric(20, 8);
  v_replacement numeric(20, 8);
  v_currency text;
  v_provider_ts timestamptz;
  v_item_fetched timestamptz;
  v_reject text;
  v_seen text[] := array[]::text[];
begin
  select * into provider_row from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  pid := provider_row.id;
  v_reference := provider_row.capabilities ? 'REFERENCE_ONLY';

  -- Sağlayıcı durumu: kapalı veya lisanssız kaynak değerleme tablosuna YAZAMAZ.
  if not provider_row.enabled then
    raise exception 'Kapalı sağlayıcı fiyat yazamaz: %', p_code using errcode = 'P0006';
  end if;
  if provider_row.license_status not in ('LICENSED', 'DEV_ONLY') then
    raise exception 'Lisanssız sağlayıcı fiyat yazamaz: %', p_code using errcode = 'P0006';
  end if;
  if provider_row.license_status = 'LICENSED' and not provider_row.redistribution_allowed then
    raise exception 'Yeniden gösterim izni olmayan sağlayıcı fiyat yazamaz: %', p_code
      using errcode = 'P0006';
  end if;
  -- Yalnızca referans kaynağı (BIST) güncel değerleme tablosuna yazamaz.
  if v_reference then
    raise exception 'Referans kaynağı değerleme fiyatı yazamaz: %', p_code using errcode = 'P0006';
  end if;

  -- Idempotency: aynı koşum anahtarı ikinci kez uygulanmaz.
  select * into existing_run from public.price_ingestion_runs where run_key = p_run_key;
  if found then
    return jsonb_build_object(
      'runId', existing_run.id, 'status', existing_run.status, 'skipped', true,
      'quoteCount', existing_run.quote_count, 'rejectedCount', existing_run.rejected_count,
      'replayed', true);
  end if;

  -- Aynı sağlayıcı için paralel ingestion engellenir; ikinci çağrı atlanır.
  if not pg_try_advisory_xact_lock(hashtext('altin:price:' || p_code)::bigint) then
    insert into public.price_ingestion_runs (provider_id, run_key, status, completed_at, safe_error_code)
    values (pid, p_run_key, 'SKIPPED', now(), 'CONCURRENT_RUN')
    returning id into run_id;
    return jsonb_build_object('runId', run_id, 'status', 'SKIPPED', 'skipped', true,
      'quoteCount', 0, 'rejectedCount', 0, 'replayed', false);
  end if;

  v_status := coalesce(p_payload->>'status', 'FAILED');
  v_fetched := coalesce((p_payload->>'fetchedAt')::timestamptz, now());

  insert into public.price_ingestion_runs
    (provider_id, run_key, status, completed_at, latency_ms, safe_error_code)
  values
    (pid, p_run_key, 'RUNNING', null,
     nullif(p_payload->>'latencyMs', '')::integer,
     nullif(p_payload->>'safeErrorCode', ''))
  returning id into run_id;

  -- Uygulama katmanının zaten karantinaya aldığı kayıtlar kalıcı hâle getirilir.
  for item in select * from jsonb_array_elements(coalesce(p_payload->'quarantined', '[]'::jsonb))
  loop
    insert into public.price_quote_quarantine
      (ingestion_run_id, provider_id, market_id, canonical_product_id, rejection_code,
       liquidation_price, replacement_price, currency, provider_timestamp, fetched_at,
       mapping_version, raw_payload_hash)
    values
      (run_id, pid, provider_row.market_id,
       coalesce(item->>'canonicalProductId', 'unknown'),
       coalesce(item->>'code', 'UNKNOWN'),
       nullif(item->>'liquidationPrice', '')::numeric,
       nullif(item->>'replacementPrice', '')::numeric,
       nullif(item->>'currency', ''),
       nullif(item->>'providerTimestamp', '')::timestamptz,
       nullif(item->>'fetchedAt', '')::timestamptz,
       nullif(item->>'mappingVersion', ''),
       nullif(item->>'rawPayloadHash', ''));
    v_rejected := v_rejected + 1;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'quotes', '[]'::jsonb))
  loop
    v_product := item->>'canonicalProductId';
    v_liquidation := nullif(item->>'liquidationPrice', '')::numeric;
    v_replacement := nullif(item->>'replacementPrice', '')::numeric;
    v_currency := coalesce(nullif(item->>'currency', ''), 'TRY');
    v_provider_ts := nullif(item->>'providerTimestamp', '')::timestamptz;
    v_item_fetched := coalesce(nullif(item->>'fetchedAt', '')::timestamptz, v_fetched);
    v_reject := null;

    -- Veritabanı seviyesinde ikinci savunma hattı. Uygulama katmanı atlansa bile
    -- bu kurallar geçerlidir ve ihlal eden kayıt DEĞERLEMEYE GİRMEZ.
    if v_product is null or not exists (
      select 1 from public.gold_products where id = v_product and is_active
    ) then
      v_reject := 'PRODUCT_UNKNOWN';
    elsif v_product = any (v_seen) then
      -- Aynı koşumda aynı kanonik ürün iki kez gelemez: "son kayıt kazanır"
      -- davranışı sessizce yanlış fiyat yazabilirdi.
      v_reject := 'DUPLICATE_CANONICAL_PRODUCT';
    elsif v_currency <> 'TRY' then
      v_reject := 'CURRENCY_NOT_TRY';
    elsif v_liquidation is null or v_replacement is null
          or v_liquidation <= 0 or v_replacement <= 0 then
      v_reject := 'PRICE_NOT_POSITIVE';
    elsif v_replacement < v_liquidation then
      v_reject := 'INVERTED_SPREAD';
    elsif v_provider_ts is null then
      v_reject := 'TIMESTAMP_INVALID';
    elsif v_provider_ts > now() + interval '5 minutes' then
      v_reject := 'TIMESTAMP_FUTURE';
    end if;

    if v_reject is not null then
      insert into public.price_quote_quarantine
        (ingestion_run_id, provider_id, market_id, canonical_product_id, rejection_code,
         liquidation_price, replacement_price, currency, provider_timestamp, fetched_at,
         mapping_version, raw_payload_hash)
      values
        (run_id, pid, provider_row.market_id, coalesce(v_product, 'unknown'), v_reject,
         v_liquidation, v_replacement, v_currency, v_provider_ts, v_item_fetched,
         nullif(item->>'mappingVersion', ''), nullif(item->>'rawPayloadHash', ''));
      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_seen := array_append(v_seen, v_product);

    insert into public.current_price_quotes as cq
      (provider_id, market_id, canonical_product_id, liquidation_price, replacement_price, currency,
       upstream_source_id, provider_timestamp, fetched_at, status, mapping_version, raw_payload_hash,
       ingestion_run_id, updated_at)
    values
      (pid, provider_row.market_id, v_product, v_liquidation, v_replacement, v_currency,
       nullif(item->>'upstreamSourceId', ''), v_provider_ts, v_item_fetched,
       coalesce(item->>'status', 'ok'),
       coalesce(item->>'mappingVersion', 'unknown'),
       nullif(item->>'rawPayloadHash', ''),
       run_id, now())
    on conflict (provider_id, canonical_product_id) do update set
      market_id = excluded.market_id,
      liquidation_price = excluded.liquidation_price,
      replacement_price = excluded.replacement_price,
      currency = excluded.currency,
      upstream_source_id = excluded.upstream_source_id,
      provider_timestamp = excluded.provider_timestamp,
      fetched_at = excluded.fetched_at,
      status = excluded.status,
      mapping_version = excluded.mapping_version,
      raw_payload_hash = excluded.raw_payload_hash,
      ingestion_run_id = excluded.ingestion_run_id,
      updated_at = now();

    insert into public.price_quote_history
      (provider_id, market_id, canonical_product_id, liquidation_price, replacement_price, currency,
       upstream_source_id, provider_timestamp, fetched_at, status, mapping_version, raw_payload_hash,
       ingestion_run_id)
    values
      (pid, provider_row.market_id, v_product, v_liquidation, v_replacement, v_currency,
       nullif(item->>'upstreamSourceId', ''), v_provider_ts, v_item_fetched,
       coalesce(item->>'status', 'ok'),
       coalesce(item->>'mappingVersion', 'unknown'),
       nullif(item->>'rawPayloadHash', ''),
       run_id)
    on conflict (ingestion_run_id, canonical_product_id) where ingestion_run_id is not null do nothing;

    v_quote_count := v_quote_count + 1;
    if coalesce(item->>'status', 'ok') = 'stale' then
      v_stale_count := v_stale_count + 1;
    end if;
  end loop;

  update public.price_ingestion_runs
  set status = case
        when v_status = 'unavailable' or (v_quote_count = 0 and v_rejected > 0) then 'FAILED'
        when v_status = 'partial' or v_rejected > 0 then 'PARTIAL'
        when v_quote_count = 0 then 'FAILED'
        else 'SUCCESS' end,
      completed_at = now(),
      quote_count = v_quote_count,
      rejected_count = v_rejected
  where id = run_id;

  insert into public.provider_health_snapshots as ph
    (provider_id, status, last_success_at, last_error_at, coverage_count, stale_count,
     quarantined_count, latency_ms, safe_error_code, updated_at)
  values
    (pid,
     case when v_quote_count > 0 and v_rejected = 0 then 'ok'
          when v_quote_count > 0 then 'degraded'
          else 'unavailable' end,
     case when v_quote_count > 0 then now() else null end,
     case when v_quote_count = 0 or v_rejected > 0 then now() else null end,
     v_quote_count, v_stale_count,
     -- Sağlık sayacı gerçek karantina SATIR sayısıyla uyumludur.
     (select count(*) from public.price_quote_quarantine where ingestion_run_id = run_id),
     nullif(p_payload->>'latencyMs', '')::integer,
     nullif(p_payload->>'safeErrorCode', ''),
     now())
  on conflict (provider_id) do update set
    status = excluded.status,
    last_success_at = coalesce(excluded.last_success_at, ph.last_success_at),
    last_error_at = coalesce(excluded.last_error_at, ph.last_error_at),
    coverage_count = excluded.coverage_count,
    stale_count = excluded.stale_count,
    quarantined_count = excluded.quarantined_count,
    latency_ms = excluded.latency_ms,
    safe_error_code = excluded.safe_error_code,
    updated_at = now();

  return jsonb_build_object(
    'runId', run_id,
    'status', (select status from public.price_ingestion_runs where id = run_id),
    'skipped', false,
    'quoteCount', v_quote_count,
    'rejectedCount', v_rejected,
    'replayed', false);
end;
$$;

revoke all on function public.price_ingestion_apply(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.price_ingestion_apply(text, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 5. Karantina okuma (yönetim ekranı)
-- -----------------------------------------------------------------------------

create or replace function public.price_quarantine_list(p_code text default null, p_limit integer default 50)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row order by row->>'createdAt' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'providerCode', pp.code,
      'marketId', q.market_id,
      'canonicalProductId', q.canonical_product_id,
      'rejectionCode', q.rejection_code,
      'liquidationPrice', case when q.liquidation_price is null then null else q.liquidation_price::text end,
      'replacementPrice', case when q.replacement_price is null then null else q.replacement_price::text end,
      'currency', q.currency,
      'providerTimestamp', q.provider_timestamp,
      'fetchedAt', q.fetched_at,
      'mappingVersion', q.mapping_version,
      'createdAt', q.created_at
    ) as row
    from public.price_quote_quarantine q
    join public.price_providers pp on pp.id = q.provider_id
    where p_code is null or pp.code = p_code
    order by q.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) s;
$$;

revoke all on function public.price_quarantine_list(text, integer) from public, anon, authenticated;
grant execute on function public.price_quarantine_list(text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Global varsayılan kaynak seçimi
-- -----------------------------------------------------------------------------

create or replace function public.price_provider_set_default(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  provider_row public.price_providers;
begin
  if p_code is null then
    update public.price_providers set is_default = false, updated_at = now() where is_default;
    return jsonb_build_object('providerCode', null);
  end if;

  select * into provider_row from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  if not provider_row.enabled or not provider_row.user_selectable then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE' using errcode = 'P0006';
  end if;
  if provider_row.capabilities ? 'REFERENCE_ONLY' then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE' using errcode = 'P0006';
  end if;

  -- Tek varsayılan: önce hepsini kapat, sonra seçileni aç.
  update public.price_providers set is_default = false, updated_at = now()
  where is_default and code <> p_code;
  update public.price_providers set is_default = true, updated_at = now() where code = p_code;

  return jsonb_build_object('providerCode', p_code);
end;
$$;

revoke all on function public.price_provider_set_default(text) from public, anon, authenticated;
grant execute on function public.price_provider_set_default(text) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Sağlayıcı bayrakları değişince varsayılan tutarlı kalır
-- -----------------------------------------------------------------------------

create or replace function public.price_provider_clear_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Kaynak kapatılır veya kullanıcıya kapatılırsa varsayılan olmaktan da çıkar;
  -- aksi hâlde kısıt ihlali oluşur ve sistem varsayılansız kalmayı bilemezdi.
  if new.is_default and (not new.enabled or not new.user_selectable) then
    new.is_default := false;
  end if;
  return new;
end;
$$;

revoke all on function public.price_provider_clear_default() from public, anon, authenticated, service_role;

drop trigger if exists price_providers_default_guard on public.price_providers;
create trigger price_providers_default_guard
  before update on public.price_providers
  for each row execute function public.price_provider_clear_default();

-- -----------------------------------------------------------------------------
-- 8. Yeni denetim eylemleri
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'admin_audit_logs_action_check'
      and conrelid = 'public.admin_audit_logs'::regclass
  ) then
    alter table public.admin_audit_logs drop constraint admin_audit_logs_action_check;
  end if;
end;
$$;

alter table public.admin_audit_logs
  add constraint admin_audit_logs_action_check check (
    action in (
      'user.create', 'user.deactivate', 'user.activate', 'user.password_reset',
      'user.view', 'user.portfolio_view', 'user.sessions_view', 'user.sessions_revoke',
      'user.delete_attempt', 'user.delete',
      'mfa.enroll', 'mfa.verify', 'mfa.reset', 'mfa.recovery_used',
      'price.provider_update', 'price.source_change', 'price.refresh',
      'price.quarantine_view', 'price.default_source',
      'data.export', 'data.deletion_request'
    )
  );
