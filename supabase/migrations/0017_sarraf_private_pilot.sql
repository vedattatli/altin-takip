-- =============================================================================
-- 0017 — SARRAF TV KAYSERİ KAPALI PİLOTU (Sprint 3.2)
--
-- 1. `EXPERIMENTAL_PRIVATE` lisans durumu: deneysel ekran gözlemi. LICENSED
--    SAYILMAZ, genel kullanıcıya açılamaz, global varsayılan olamaz.
-- 2. `experimental_price_access`: hangi portföyün deneysel kaynağı
--    kullanabileceğini YÖNETİCİ belirler. Kullanıcı kendi kendine açamaz.
-- 3. `price_mapping_approvals`: yönetici, ekran etiketi ↔ kanonik ürün
--    eşlemesini kanıtıyla onaylar (OPERATOR_VERIFIED).
-- 4. `price_worker_nonces` + `price_worker_leases`: imzalı makine ucu için
--    replay koruması ve "aynı anda tek worker" garantisi.
--
-- Ham payload, adres, anahtar veya kişisel veri HİÇBİR tabloda saklanmaz.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Deneysel lisans durumu
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'price_providers_license_check'
      and conrelid = 'public.price_providers'::regclass
  ) then
    alter table public.price_providers drop constraint price_providers_license_check;
  end if;
  if exists (
    select 1 from pg_constraint
    where conname = 'price_providers_enabled_requires_license'
      and conrelid = 'public.price_providers'::regclass
  ) then
    alter table public.price_providers drop constraint price_providers_enabled_requires_license;
  end if;
end;
$$;

alter table public.price_providers
  add constraint price_providers_license_check
  check (license_status in ('DEV_ONLY', 'NOT_CONFIGURED', 'LICENSE_REQUIRED', 'LICENSED', 'EXPERIMENTAL_PRIVATE'));

-- Deneysel kaynak etkinleştirilebilir ama LİSANSLI SAYILMAZ; kullanıcıya genel
-- olarak açılması ayrıca `price_providers_experimental_not_public` ile engellenir.
alter table public.price_providers
  add constraint price_providers_enabled_requires_license
  check (not enabled or (license_status in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE')));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'price_providers_experimental_not_public'
      and conrelid = 'public.price_providers'::regclass
  ) then
    alter table public.price_providers
      add constraint price_providers_experimental_not_public
      -- Deneysel kaynak "kullanıcıya açık" listesine giremez: erişim yalnızca
      -- portföy bazlı izin listesiyle verilir.
      check (license_status <> 'EXPERIMENTAL_PRIVATE' or not user_selectable);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Deneysel erişim izin listesi (portföy bazlı)
-- -----------------------------------------------------------------------------

create table if not exists public.experimental_price_access (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  enabled boolean not null default true,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now(),
  expires_at timestamptz,
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint experimental_price_access_unique unique (portfolio_id, provider_id)
);

create index if not exists experimental_price_access_portfolio_idx
  on public.experimental_price_access (portfolio_id) where enabled;

alter table public.experimental_price_access enable row level security;
alter table public.experimental_price_access force row level security;

revoke all on table public.experimental_price_access from public, anon, authenticated;
revoke all on table public.experimental_price_access from service_role;
grant select on table public.experimental_price_access to service_role;

-- Kullanıcı yalnızca KENDİ portföyünün iznini GÖREBİLİR; değiştiremez.
drop policy if exists experimental_access_select_own on public.experimental_price_access;
create policy experimental_access_select_own on public.experimental_price_access
  for select to authenticated
  using (
    exists (
      select 1 from public.portfolios p
      where p.id = experimental_price_access.portfolio_id and p.user_id = auth.uid()
    )
  );

grant select on table public.experimental_price_access to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Eşleme onayları (OPERATOR_VERIFIED)
-- -----------------------------------------------------------------------------

create table if not exists public.price_mapping_approvals (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.price_providers (id) on delete cascade,
  /** Ekranda görünen ham etiket (normalize edilmiş). */
  raw_label text not null,
  canonical_product_id text not null,
  confidence text not null,
  mapping_version text not null,
  /** Onay anındaki kanıt: ekran fiyatı ve gözlem zamanı (ham payload DEĞİL). */
  evidence_liquidation numeric(20, 8),
  evidence_replacement numeric(20, 8),
  evidence_observed_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,

  constraint price_mapping_approvals_confidence_check
    check (confidence in ('OPERATOR_VERIFIED', 'GROUPED_EXPLICIT')),
  constraint price_mapping_approvals_unique unique (provider_id, raw_label, mapping_version)
);

create index if not exists price_mapping_approvals_active_idx
  on public.price_mapping_approvals (provider_id, canonical_product_id) where revoked_at is null;

alter table public.price_mapping_approvals enable row level security;
alter table public.price_mapping_approvals force row level security;

revoke all on table public.price_mapping_approvals from public, anon, authenticated;
revoke all on table public.price_mapping_approvals from service_role;
grant select on table public.price_mapping_approvals to service_role;

-- -----------------------------------------------------------------------------
-- 4. Worker replay koruması ve tek worker garantisi
-- -----------------------------------------------------------------------------

create table if not exists public.price_worker_nonces (
  nonce text primary key,
  worker_id text not null,
  seen_at timestamptz not null default now()
);

create index if not exists price_worker_nonces_seen_idx on public.price_worker_nonces (seen_at);

alter table public.price_worker_nonces enable row level security;
alter table public.price_worker_nonces force row level security;
revoke all on table public.price_worker_nonces from public, anon, authenticated, service_role;
grant select on table public.price_worker_nonces to service_role;

create table if not exists public.price_worker_leases (
  provider_code text primary key,
  worker_id text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now()
);

alter table public.price_worker_leases enable row level security;
alter table public.price_worker_leases force row level security;
revoke all on table public.price_worker_leases from public, anon, authenticated, service_role;
grant select on table public.price_worker_leases to service_role;

-- -----------------------------------------------------------------------------
-- 5. RPC'ler
-- -----------------------------------------------------------------------------

/**
 * Nonce'u TEK KULLANIMLIK olarak talep eder.
 * Aynı nonce ikinci kez gönderilirse false döner (replay reddi).
 */
create or replace function public.price_worker_nonce_claim(p_nonce text, p_worker_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Eski kayıtlar temizlenir; tablo sınırsız büyümez.
  delete from public.price_worker_nonces where seen_at < now() - interval '1 hour';
  insert into public.price_worker_nonces (nonce, worker_id) values (p_nonce, p_worker_id);
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

revoke all on function public.price_worker_nonce_claim(text, text) from public, anon, authenticated;
grant execute on function public.price_worker_nonce_claim(text, text) to service_role;

/**
 * Worker kirası: aynı sağlayıcı için AYNI ANDA yalnızca bir worker yazabilir.
 * Kira süresi dolmuşsa başka worker devralabilir; devralındıktan sonra eski
 * worker'ın gönderisi reddedilir (split-brain koruması).
 */
create or replace function public.price_worker_lease_acquire(
  p_code text, p_worker_id text, p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.price_worker_leases;
begin
  select * into current_row from public.price_worker_leases where provider_code = p_code for update;

  if not found then
    insert into public.price_worker_leases (provider_code, worker_id, expires_at)
    values (p_code, p_worker_id, now() + make_interval(secs => greatest(30, p_ttl_seconds)));
    return jsonb_build_object('held', true, 'workerId', p_worker_id, 'takeover', false);
  end if;

  if current_row.worker_id = p_worker_id then
    update public.price_worker_leases
    set expires_at = now() + make_interval(secs => greatest(30, p_ttl_seconds)),
        heartbeat_at = now()
    where provider_code = p_code;
    return jsonb_build_object('held', true, 'workerId', p_worker_id, 'takeover', false);
  end if;

  if current_row.expires_at > now() then
    return jsonb_build_object('held', false, 'workerId', current_row.worker_id, 'takeover', false);
  end if;

  update public.price_worker_leases
  set worker_id = p_worker_id,
      acquired_at = now(),
      heartbeat_at = now(),
      expires_at = now() + make_interval(secs => greatest(30, p_ttl_seconds))
  where provider_code = p_code;
  return jsonb_build_object('held', true, 'workerId', p_worker_id, 'takeover', true);
end;
$$;

revoke all on function public.price_worker_lease_acquire(text, text, integer) from public, anon, authenticated;
grant execute on function public.price_worker_lease_acquire(text, text, integer) to service_role;

/** Kira durumu (yönetim ekranı). */
create or replace function public.price_worker_lease_state(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case when l.provider_code is null then null else jsonb_build_object(
    'workerId', l.worker_id,
    'acquiredAt', l.acquired_at,
    'heartbeatAt', l.heartbeat_at,
    'expiresAt', l.expires_at,
    'active', l.expires_at > now()
  ) end
  from public.price_worker_leases l
  where l.provider_code = p_code;
$$;

revoke all on function public.price_worker_lease_state(text) from public, anon, authenticated;
grant execute on function public.price_worker_lease_state(text) to service_role;

/** Yönetici: portföye deneysel erişim verir veya kaldırır. */
create or replace function public.experimental_access_set(
  p_user_id uuid, p_code text, p_enabled boolean, p_admin uuid, p_reason text, p_expires timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  provider_row public.price_providers;
  portfolio uuid;
begin
  select * into provider_row from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  if provider_row.license_status <> 'EXPERIMENTAL_PRIVATE' then
    raise exception 'ALTIN_NOT_EXPERIMENTAL_PROVIDER' using errcode = 'P0006';
  end if;
  pid := provider_row.id;

  select id into portfolio from public.portfolios where user_id = p_user_id limit 1;
  if portfolio is null then
    raise exception 'Portföy bulunamadı' using errcode = 'P0004';
  end if;

  insert into public.experimental_price_access
    (portfolio_id, provider_id, enabled, approved_by, approved_at, expires_at, reason, updated_at)
  values (portfolio, pid, p_enabled, p_admin, now(), p_expires, coalesce(p_reason, ''), now())
  on conflict (portfolio_id, provider_id) do update set
    enabled = excluded.enabled,
    approved_by = excluded.approved_by,
    approved_at = now(),
    expires_at = excluded.expires_at,
    reason = excluded.reason,
    updated_at = now();

  return jsonb_build_object('portfolioId', portfolio, 'providerCode', p_code, 'enabled', p_enabled);
end;
$$;

revoke all on function public.experimental_access_set(uuid, text, boolean, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.experimental_access_set(uuid, text, boolean, uuid, text, timestamptz) to service_role;

/** Bir portföy deneysel kaynağı kullanabilir mi? */
create or replace function public.experimental_access_allowed(p_user_id uuid, p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.experimental_price_access a
    join public.portfolios p on p.id = a.portfolio_id
    join public.price_providers pr on pr.id = a.provider_id
    where p.user_id = p_user_id
      and pr.code = p_code
      and a.enabled
      and (a.expires_at is null or a.expires_at > now())
  );
$$;

revoke all on function public.experimental_access_allowed(uuid, text) from public, anon, authenticated;
grant execute on function public.experimental_access_allowed(uuid, text) to service_role;

/** Yönetim ekranı: izin listesi. */
create or replace function public.experimental_access_list(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'username', pr.username,
    'displayName', pr.display_name,
    'portfolioId', a.portfolio_id,
    'enabled', a.enabled,
    'approvedAt', a.approved_at,
    'expiresAt', a.expires_at,
    'reason', a.reason
  ) order by pr.username), '[]'::jsonb)
  from public.experimental_price_access a
  join public.portfolios p on p.id = a.portfolio_id
  join public.profiles pr on pr.id = p.user_id
  join public.price_providers prov on prov.id = a.provider_id
  where prov.code = p_code;
$$;

revoke all on function public.experimental_access_list(text) from public, anon, authenticated;
grant execute on function public.experimental_access_list(text) to service_role;

/** Yönetici: ekran etiketi ↔ kanonik ürün eşlemesini onaylar veya geri alır. */
create or replace function public.price_mapping_approve(
  p_code text,
  p_label text,
  p_product text,
  p_version text,
  p_admin uuid,
  p_liquidation numeric,
  p_replacement numeric,
  p_observed timestamptz,
  p_revoke boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  select id into pid from public.price_providers where code = p_code;
  if pid is null then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  if not exists (select 1 from public.gold_products where id = p_product and is_active) then
    raise exception 'Bilinmeyen ürün: %', p_product using errcode = 'P0004';
  end if;

  if p_revoke then
    update public.price_mapping_approvals
    set revoked_at = now()
    where provider_id = pid and raw_label = p_label and mapping_version = p_version;
    return jsonb_build_object('label', p_label, 'revoked', true);
  end if;

  insert into public.price_mapping_approvals
    (provider_id, raw_label, canonical_product_id, confidence, mapping_version,
     evidence_liquidation, evidence_replacement, evidence_observed_at, approved_by)
  values (pid, p_label, p_product, 'OPERATOR_VERIFIED', p_version,
          p_liquidation, p_replacement, p_observed, p_admin)
  on conflict (provider_id, raw_label, mapping_version) do update set
    canonical_product_id = excluded.canonical_product_id,
    evidence_liquidation = excluded.evidence_liquidation,
    evidence_replacement = excluded.evidence_replacement,
    evidence_observed_at = excluded.evidence_observed_at,
    approved_by = excluded.approved_by,
    approved_at = now(),
    revoked_at = null;

  return jsonb_build_object('label', p_label, 'productId', p_product, 'revoked', false);
end;
$$;

revoke all on function public.price_mapping_approve(text, text, text, text, uuid, numeric, numeric, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.price_mapping_approve(text, text, text, text, uuid, numeric, numeric, timestamptz, boolean)
  to service_role;

/** Etkin eşleme onayları. */
create or replace function public.price_mapping_approvals_list(p_code text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'rawLabel', a.raw_label,
    'canonicalProductId', a.canonical_product_id,
    'confidence', a.confidence,
    'mappingVersion', a.mapping_version,
    'evidenceLiquidation', case when a.evidence_liquidation is null then null else a.evidence_liquidation::text end,
    'evidenceReplacement', case when a.evidence_replacement is null then null else a.evidence_replacement::text end,
    'evidenceObservedAt', a.evidence_observed_at,
    'approvedBy', pr.username,
    'approvedAt', a.approved_at
  ) order by a.raw_label), '[]'::jsonb)
  from public.price_mapping_approvals a
  join public.price_providers p on p.id = a.provider_id
  left join public.profiles pr on pr.id = a.approved_by
  where p.code = p_code and a.revoked_at is null;
$$;

revoke all on function public.price_mapping_approvals_list(text) from public, anon, authenticated;
grant execute on function public.price_mapping_approvals_list(text) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Deneysel kaynak global varsayılan olamaz
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
  -- Deneysel kaynak hiçbir koşulda global varsayılan olamaz.
  if provider_row.license_status = 'EXPERIMENTAL_PRIVATE' then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE' using errcode = 'P0006';
  end if;

  update public.price_providers set is_default = false, updated_at = now()
  where is_default and code <> p_code;
  update public.price_providers set is_default = true, updated_at = now() where code = p_code;

  return jsonb_build_object('providerCode', p_code);
end;
$$;

revoke all on function public.price_provider_set_default(text) from public, anon, authenticated;
grant execute on function public.price_provider_set_default(text) to service_role;

-- -----------------------------------------------------------------------------
-- 7. Ingestion: deneysel kaynak da yazabilir (lisanslı sayılmadan)
-- -----------------------------------------------------------------------------

create or replace function public.price_ingestion_allowed_status(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE');
$$;

revoke all on function public.price_ingestion_allowed_status(text) from public, anon, authenticated, service_role;

-- Alım RPC'si yeniden tanımlanır: tek fark, izinli lisans durumları listesinin
-- artık `EXPERIMENTAL_PRIVATE` içermesidir. Deneysel kaynak yazabilir ama
-- LİSANSLI SAYILMAZ ve kullanıcıya genel olarak açılamaz.
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
  if not public.price_ingestion_allowed_status(provider_row.license_status) then
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
      -- Worker bir yönetici DEĞİLDİR: yazmalarının izi price_ingestion_runs'tadır,
      -- yönetici denetim kaydında değil.
      'price.experimental_access', 'price.mapping_approve',
      'data.export', 'data.deletion_request'
    )
  );

-- -----------------------------------------------------------------------------
-- 9. Kaynak seçimi: deneysel pilot izni
--
-- 0014'teki price_preference_set yeniden tanımlanır. Tek fark: user_selectable
-- olmayan bir kaynak, EXPERIMENTAL_PRIVATE ise ve kullanıcı izin listesindeyse
-- seçilebilir. Diğer bütün kurallar (enabled, REFERENCE_ONLY, denetim izi)
-- aynen korunur.
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
    -- Deneysel özel pilot kaynağı genel listede DEĞİLDİR. Erişim yalnızca
    -- yönetici onaylı izin listesinden gelir ve burada da doğrulanır; arayüzün
    -- kaynağı göstermesi tek başına yetki sayılmaz.
    if not (target.license_status = 'EXPERIMENTAL_PRIVATE'
            and public.experimental_access_allowed(p_user_id, p_code)) then
      raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE: % kaynağı kullanıcı seçimine kapalı.', p_code
        using errcode = 'P0006';
    end if;
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
-- 10. Sağlayıcı bayrakları: deneysel kaynak etkinleştirilebilir, açılamaz
--
-- 0014'teki price_provider_set_flags yeniden tanımlanır. Deneysel pilot kaynağı
-- ETKİNLEŞTİRİLEBİLİR (worker yazabilsin diye) ama kullanıcı listesine ASLA
-- açılamaz; erişim yalnızca experimental_price_access üzerinden verilir.
-- Diğer lisans kuralları aynen korunur.
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
  if p_user_selectable and row_data.license_status = 'EXPERIMENTAL_PRIVATE' then
    raise exception 'ALTIN_PROVIDER_NOT_SELECTABLE: % deneysel kaynağı genel listeye açılamaz.', p_code
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
-- 11. Ekran türü, istemci yetkisi ve katalog eşitlemesi
--
-- (a) provider_type'a 'SCREEN' eklenir: ekran gözlemi bir REST sözleşmesi değildir.
-- (b) Pilot tabloları istemciye kapatılır (varsayılan ACL birleşmesi SELECT bırakmıştı).
-- (c) price_providers_sync deneysel kaynağı otomatik kapatmaz; ama kullanıcı
--     listesine de ASLA açmaz (user_selectable kuralı olduğu gibi korunur).
-- -----------------------------------------------------------------------------

alter table public.price_providers drop constraint if exists price_providers_type_check;
alter table public.price_providers
  add constraint price_providers_type_check
  check (provider_type in ('MOCK', 'REST', 'WEBSOCKET', 'XML', 'REFERENCE', 'SCREEN'));

revoke all on public.experimental_price_access from anon, authenticated;
revoke all on public.price_mapping_approvals from anon, authenticated;
revoke all on public.price_worker_nonces from anon, authenticated;
revoke all on public.price_worker_leases from anon, authenticated;
grant select on public.experimental_price_access to service_role;
grant select on public.price_mapping_approvals to service_role;
grant select on public.price_worker_nonces to service_role;
grant select on public.price_worker_leases to service_role;

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
      -- Lisans kaybedildiyse kaynak otomatik olarak devre dışı kalır (fail closed).
      -- EXPERIMENTAL_PRIVATE kapsam dışıdır: özel pilot kaynağı açık kalabilir.
      enabled = pp.enabled
        and excluded.license_status in ('LICENSED', 'DEV_ONLY', 'EXPERIMENTAL_PRIVATE'),
      user_selectable = pp.user_selectable
        and pp.enabled
        and excluded.license_status in ('LICENSED', 'DEV_ONLY'),
      updated_at = now();
    affected := affected + 1;
  end loop;

  return affected;
end;
$$;

revoke all on function public.price_providers_sync(jsonb) from public, anon, authenticated;
grant execute on function public.price_providers_sync(jsonb) to service_role;
