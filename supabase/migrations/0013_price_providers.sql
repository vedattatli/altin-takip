-- =============================================================================
-- Altın Takip — 0013 Çoklu fiyat kaynağı (Sprint 3)
--
-- Sağlayıcı kataloğu, sembol eşlemeleri, merkezi fiyat alımı (ingestion),
-- güncel/tarihsel fiyat, sağlık kaydı, portföy bazlı kaynak tercihi ve kaynak
-- değişim olayları.
--
-- SINIR: fiyat tabloları istemciye AÇILMAZ. anon/authenticated hiçbir fiyat
-- tablosunu doğrudan okuyamaz veya yazamaz; erişim yalnızca BFF (service_role)
-- üzerinden SECURITY DEFINER RPC'lerle olur. Tek istisna:
-- portfolio_price_preferences kullanıcının KENDİ satırını okuyabilir (RLS).
--
-- API anahtarı / credential veritabanında TUTULMAZ; yalnızca ortam değişkeni
-- adları ve lisans referansı saklanır.
--
-- Eski migration'lar değiştirilmez; bu dosya tekrar çalıştırılabilir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Sağlayıcı kataloğu
-- -----------------------------------------------------------------------------

create table if not exists public.price_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  technical_name text not null default '',
  market_id text not null,
  market_display_name text not null default '',
  provider_type text not null,
  enabled boolean not null default false,
  -- Kullanıcıların bu kaynağı seçmesine izin verilir mi? (admin allowlist)
  user_selectable boolean not null default false,
  license_status text not null default 'NOT_CONFIGURED',
  license_reference text,
  redistribution_allowed boolean not null default false,
  capabilities jsonb not null default '[]'::jsonb,
  attribution text not null default '',
  reference_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint price_providers_type_check
    check (provider_type in ('MOCK', 'REST', 'WEBSOCKET', 'XML', 'REFERENCE')),
  constraint price_providers_license_check
    check (license_status in ('DEV_ONLY', 'NOT_CONFIGURED', 'LICENSE_REQUIRED', 'LICENSED')),
  -- Lisanslı olmayan veya yeniden gösterim izni bulunmayan kaynak etkinleştirilemez.
  constraint price_providers_enabled_requires_license
    check (not enabled or (license_status in ('LICENSED', 'DEV_ONLY'))),
  constraint price_providers_selectable_requires_enabled
    check (not user_selectable or enabled)
);

comment on table public.price_providers is
  'Fiyat sağlayıcı kataloğu. Credential SAKLANMAZ; yalnızca lisans durumu ve referans.';

create index if not exists price_providers_market_idx on public.price_providers (market_id);

-- -----------------------------------------------------------------------------
-- 2. Sembol → kanonik ürün eşlemeleri
-- -----------------------------------------------------------------------------

create table if not exists public.price_product_mappings (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  provider_symbol text not null,
  canonical_product_id text not null references public.gold_products (id),
  mapping_version text not null,
  active boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists price_product_mappings_active_idx
  on public.price_product_mappings (provider_id, provider_symbol, mapping_version);
create index if not exists price_product_mappings_product_idx
  on public.price_product_mappings (canonical_product_id);

-- -----------------------------------------------------------------------------
-- 3. Fiyat alım koşuları (ingestion runs)
-- -----------------------------------------------------------------------------

create table if not exists public.price_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  run_key text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'RUNNING',
  quote_count integer not null default 0,
  rejected_count integer not null default 0,
  latency_ms integer,
  -- Güvenli hata kodu; ham payload veya secret İÇERMEZ.
  safe_error_code text,

  constraint price_ingestion_runs_status_check
    check (status in ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'))
);

create unique index if not exists price_ingestion_runs_key_idx on public.price_ingestion_runs (run_key);
create index if not exists price_ingestion_runs_provider_idx
  on public.price_ingestion_runs (provider_id, started_at desc);

comment on column public.price_ingestion_runs.safe_error_code is
  'Yalnızca güvenli kod (TIMEOUT, HTTP_401, PARTIAL_COVERAGE...). Ham yanıt ve API anahtarı yazılmaz.';

-- -----------------------------------------------------------------------------
-- 4. Güncel ve tarihsel fiyatlar
-- -----------------------------------------------------------------------------

create table if not exists public.current_price_quotes (
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  market_id text not null,
  canonical_product_id text not null references public.gold_products (id),
  liquidation_price numeric(20, 8) not null,
  replacement_price numeric(20, 8) not null,
  currency text not null default 'TRY',
  upstream_source_id text,
  provider_timestamp timestamptz not null,
  fetched_at timestamptz not null,
  status text not null default 'ok',
  mapping_version text not null,
  raw_payload_hash text,
  ingestion_run_id uuid references public.price_ingestion_runs (id) on delete set null,
  updated_at timestamptz not null default now(),

  primary key (provider_id, canonical_product_id),
  constraint current_price_quotes_positive check (liquidation_price > 0 and replacement_price > 0),
  constraint current_price_quotes_spread check (replacement_price >= liquidation_price),
  constraint current_price_quotes_currency check (currency = 'TRY'),
  constraint current_price_quotes_status check (status in ('ok', 'stale', 'quarantined'))
);

create index if not exists current_price_quotes_product_idx
  on public.current_price_quotes (canonical_product_id);

create table if not exists public.price_quote_history (
  id bigint generated by default as identity primary key,
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  market_id text not null,
  canonical_product_id text not null references public.gold_products (id),
  liquidation_price numeric(20, 8) not null,
  replacement_price numeric(20, 8) not null,
  currency text not null default 'TRY',
  upstream_source_id text,
  provider_timestamp timestamptz not null,
  fetched_at timestamptz not null,
  status text not null,
  mapping_version text not null,
  raw_payload_hash text,
  ingestion_run_id uuid references public.price_ingestion_runs (id) on delete set null,
  recorded_at timestamptz not null default now()
);

-- Aynı koşumda aynı ürün iki kez yazılmaz (idempotent ingestion).
create unique index if not exists price_quote_history_run_product_idx
  on public.price_quote_history (ingestion_run_id, canonical_product_id)
  where ingestion_run_id is not null;
create index if not exists price_quote_history_lookup_idx
  on public.price_quote_history (provider_id, canonical_product_id, provider_timestamp desc);

/** Fiyat geçmişi append-only: güncellenemez, silinemez (sağlayıcı cascade'i hariç). */
create or replace function public.reject_price_history_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.price_providers where id = old.provider_id) then
      raise exception 'Fiyat geçmişi silinemez.' using errcode = '42501';
    end if;
    return old;
  end if;
  raise exception 'Fiyat geçmişi değiştirilemez.' using errcode = '42501';
end;
$$;

drop trigger if exists price_quote_history_no_update on public.price_quote_history;
create trigger price_quote_history_no_update
  before update on public.price_quote_history
  for each row execute function public.reject_price_history_mutation();

drop trigger if exists price_quote_history_no_delete on public.price_quote_history;
create trigger price_quote_history_no_delete
  before delete on public.price_quote_history
  for each row execute function public.reject_price_history_mutation();

-- -----------------------------------------------------------------------------
-- 5. Sağlayıcı sağlık kaydı
-- -----------------------------------------------------------------------------

create table if not exists public.provider_health_snapshots (
  provider_id uuid primary key references public.price_providers (id) on delete cascade,
  status text not null,
  last_success_at timestamptz,
  last_error_at timestamptz,
  coverage_count integer not null default 0,
  stale_count integer not null default 0,
  quarantined_count integer not null default 0,
  latency_ms integer,
  safe_error_code text,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 6. Portföy bazlı kaynak tercihi ve değişim olayları
-- -----------------------------------------------------------------------------

create table if not exists public.portfolio_price_preferences (
  portfolio_id uuid primary key references public.portfolios (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  selected_provider_id uuid references public.price_providers (id) on delete set null,
  selected_market_id text,
  selected_at timestamptz not null default now(),
  selected_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists portfolio_price_preferences_user_idx
  on public.portfolio_price_preferences (user_id);

alter table public.portfolio_price_preferences enable row level security;
alter table public.portfolio_price_preferences force row level security;

drop policy if exists portfolio_price_preferences_select_own on public.portfolio_price_preferences;
create policy portfolio_price_preferences_select_own on public.portfolio_price_preferences
  for select to authenticated
  using (user_id = auth.uid());

create table if not exists public.price_source_change_events (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  previous_provider_id uuid references public.price_providers (id) on delete set null,
  new_provider_id uuid references public.price_providers (id) on delete set null,
  previous_market_id text,
  new_market_id text,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  changed_by_role text not null default 'user',
  reason text not null default '',

  constraint price_source_change_events_role_check check (changed_by_role in ('user', 'admin'))
);

create index if not exists price_source_change_events_portfolio_idx
  on public.price_source_change_events (portfolio_id, changed_at desc);

alter table public.price_source_change_events enable row level security;
alter table public.price_source_change_events force row level security;

drop policy if exists price_source_change_events_select_own on public.price_source_change_events;
create policy price_source_change_events_select_own on public.price_source_change_events
  for select to authenticated
  using (user_id = auth.uid());

/** Kaynak değişim olayları değiştirilemez (denetim izi). */
create or replace function public.reject_price_source_event_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.profiles where id = old.user_id) then
      raise exception 'Kaynak değişim kaydı silinemez.' using errcode = '42501';
    end if;
    return old;
  end if;
  raise exception 'Kaynak değişim kaydı değiştirilemez.' using errcode = '42501';
end;
$$;

drop trigger if exists price_source_change_events_no_update on public.price_source_change_events;
create trigger price_source_change_events_no_update
  before update on public.price_source_change_events
  for each row execute function public.reject_price_source_event_mutation();

drop trigger if exists price_source_change_events_no_delete on public.price_source_change_events;
create trigger price_source_change_events_no_delete
  before delete on public.price_source_change_events
  for each row execute function public.reject_price_source_event_mutation();

-- -----------------------------------------------------------------------------
-- 7. Yetkiler — fiyat tabloları istemciye kapalı
-- -----------------------------------------------------------------------------

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'public.price_providers',
    'public.price_product_mappings',
    'public.price_ingestion_runs',
    'public.current_price_quotes',
    'public.price_quote_history',
    'public.provider_health_snapshots',
    'public.portfolio_price_preferences',
    'public.price_source_change_events'
  ]
  loop
    execute format('revoke all on table %s from public', tbl);
    execute format('revoke all on table %s from anon', tbl);
    execute format('revoke all on table %s from authenticated', tbl);
    execute format('revoke all on table %s from service_role', tbl);
    -- Yazma YALNIZCA SECURITY DEFINER RPC ile; service_role doğrudan yazamaz.
    execute format('grant select on table %s to service_role', tbl);
  end loop;
end;
$$;

-- Kullanıcı yalnızca KENDİ tercih ve değişim kaydını okuyabilir (RLS kapsamlı).
grant select on table public.portfolio_price_preferences to authenticated;
grant select on table public.price_source_change_events to authenticated;

-- price_quote_history identity dizisi RPC (sahip) tarafından kullanılır.
