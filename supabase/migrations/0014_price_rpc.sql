-- =============================================================================
-- Altın Takip — 0014 Fiyat kaynağı RPC'leri (Sprint 3)
--
-- Bütün fiyat yazma ve okuma işlemleri SECURITY DEFINER RPC'lerden geçer ve
-- yalnızca service_role (BFF) çağırabilir. Kurallar:
--   - Aynı sağlayıcı için iki ingestion PARALEL çalışamaz (advisory lock);
--     ikinci çağrı SKIPPED döner.
--   - Aynı run_key ile tekrar çağrı yeni kayıt üretmez (idempotent).
--   - Güncel fiyat upsert edilir; geçmiş yalnızca EKLENİR (append-only).
--   - Lisanssız / yeniden gösterim izni olmayan sağlayıcı etkinleştirilemez.
--   - Kaynak değişimi her zaman price_source_change_events kaydı üretir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Katalog senkronizasyonu (koddaki tanımlardan)
-- -----------------------------------------------------------------------------

/**
 * Sağlayıcı kataloğunu koddaki tanımlarla eşitler (idempotent).
 * Yalnızca metadata yazar; enabled / user_selectable yönetici kararıdır ve
 * mevcut değerleri KORUNUR.
 */
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
      enabled = pp.enabled and excluded.license_status in ('LICENSED', 'DEV_ONLY'),
      user_selectable = pp.user_selectable
        and pp.enabled
        and excluded.license_status in ('LICENSED', 'DEV_ONLY'),
      updated_at = now();
    affected := affected + 1;
  end loop;

  return affected;
end;
$$;

/** Sembol eşlemelerini eşitler (idempotent). */
create or replace function public.price_mappings_sync(p_code text, p_mapping_version text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  item record;
  affected integer := 0;
begin
  select id into pid from public.price_providers where code = p_code;
  if pid is null then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;

  for item in select key as symbol, value as product from jsonb_each_text(p_payload)
  loop
    if not exists (select 1 from public.gold_products where id = item.product) then
      continue;
    end if;
    insert into public.price_product_mappings
      (provider_id, provider_symbol, canonical_product_id, mapping_version, active)
    values (pid, item.symbol, item.product, p_mapping_version, true)
    on conflict (provider_id, provider_symbol, mapping_version) do update set
      canonical_product_id = excluded.canonical_product_id,
      active = true;
    affected := affected + 1;
  end loop;

  -- Eski sürüm eşlemeleri pasifleştirilir; geçmiş kayıtların izlenebilirliği için silinmez.
  update public.price_product_mappings
  set active = false, effective_to = coalesce(effective_to, now())
  where provider_id = pid and mapping_version <> p_mapping_version and active;

  return affected;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Yönetici bayrakları
-- -----------------------------------------------------------------------------

/**
 * Yönetici sağlayıcıyı etkinleştirir / kullanıcıya açar.
 * Lisans LICENSED (veya geliştirmede DEV_ONLY) değilse etkinleştirme REDDEDİLİR.
 */
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

  if p_enabled and row_data.license_status not in ('LICENSED', 'DEV_ONLY') then
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

-- -----------------------------------------------------------------------------
-- 3. Fiyat alımı (ingestion) — atomik, kilitli, idempotent
-- -----------------------------------------------------------------------------

/**
 * Bir sağlayıcının fiyatlarını uygular.
 *
 * p_payload: {
 *   status, safeErrorCode, latencyMs, fetchedAt,
 *   quotes: [{ canonicalProductId, liquidationPrice, replacementPrice, upstreamSourceId,
 *              providerTimestamp, fetchedAt, mappingVersion, rawPayloadHash }],
 *   quarantined: [{ canonicalProductId, code }]
 * }
 * Sayısal alanlar METİN olarak gelir.
 */
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
begin
  select * into provider_row from public.price_providers where code = p_code;
  if not found then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  pid := provider_row.id;

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

  for item in select * from jsonb_array_elements(coalesce(p_payload->'quotes', '[]'::jsonb))
  loop
    -- Güncel fiyat: upsert. Geçmiş: append-only (aynı koşumda ürün bir kez).
    insert into public.current_price_quotes as cq
      (provider_id, market_id, canonical_product_id, liquidation_price, replacement_price, currency,
       upstream_source_id, provider_timestamp, fetched_at, status, mapping_version, raw_payload_hash,
       ingestion_run_id, updated_at)
    values
      (pid, provider_row.market_id, item->>'canonicalProductId',
       (item->>'liquidationPrice')::numeric, (item->>'replacementPrice')::numeric, 'TRY',
       nullif(item->>'upstreamSourceId', ''),
       (item->>'providerTimestamp')::timestamptz,
       coalesce((item->>'fetchedAt')::timestamptz, v_fetched),
       coalesce(item->>'status', 'ok'),
       coalesce(item->>'mappingVersion', 'unknown'),
       nullif(item->>'rawPayloadHash', ''),
       run_id, now())
    on conflict (provider_id, canonical_product_id) do update set
      market_id = excluded.market_id,
      liquidation_price = excluded.liquidation_price,
      replacement_price = excluded.replacement_price,
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
      (pid, provider_row.market_id, item->>'canonicalProductId',
       (item->>'liquidationPrice')::numeric, (item->>'replacementPrice')::numeric, 'TRY',
       nullif(item->>'upstreamSourceId', ''),
       (item->>'providerTimestamp')::timestamptz,
       coalesce((item->>'fetchedAt')::timestamptz, v_fetched),
       coalesce(item->>'status', 'ok'),
       coalesce(item->>'mappingVersion', 'unknown'),
       nullif(item->>'rawPayloadHash', ''),
       run_id)
    -- Kısmi benzersiz indeks: ON CONFLICT aynı yüklemi tekrar etmelidir.
    on conflict (ingestion_run_id, canonical_product_id) where ingestion_run_id is not null do nothing;

    v_quote_count := v_quote_count + 1;
    if coalesce(item->>'status', 'ok') = 'stale' then
      v_stale_count := v_stale_count + 1;
    end if;
  end loop;

  v_rejected := jsonb_array_length(coalesce(p_payload->'quarantined', '[]'::jsonb));

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
     v_quote_count, v_stale_count, v_rejected,
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

-- -----------------------------------------------------------------------------
-- 4. Okuma RPC'leri
-- -----------------------------------------------------------------------------

create or replace function public.price_quote_json(q public.current_price_quotes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'canonicalProductId', q.canonical_product_id,
    'marketId', q.market_id,
    'liquidationPrice', public.ledger_num_text(q.liquidation_price),
    'replacementPrice', public.ledger_num_text(q.replacement_price),
    'currency', q.currency,
    'upstreamSourceId', q.upstream_source_id,
    'providerTimestamp', q.provider_timestamp,
    'fetchedAt', q.fetched_at,
    'status', q.status,
    'mappingVersion', q.mapping_version
  );
$$;

/** Bir sağlayıcının güncel fiyatları (yalnızca 'ok' durumundakiler değerlemeye girer). */
create or replace function public.price_quotes_current(p_code text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'providerCode', p.code,
    'providerId', p.id,
    'marketId', p.market_id,
    'displayName', p.display_name,
    'technicalName', p.technical_name,
    'marketDisplayName', p.market_display_name,
    'licenseStatus', p.license_status,
    'enabled', p.enabled,
    'userSelectable', p.user_selectable,
    'attribution', p.attribution,
    'health', (select jsonb_build_object(
                 'status', h.status, 'lastSuccessAt', h.last_success_at, 'lastErrorAt', h.last_error_at,
                 'coverageCount', h.coverage_count, 'staleCount', h.stale_count,
                 'quarantinedCount', h.quarantined_count, 'latencyMs', h.latency_ms,
                 'safeErrorCode', h.safe_error_code)
               from public.provider_health_snapshots h where h.provider_id = p.id),
    'quotes', coalesce((select jsonb_agg(public.price_quote_json(q) order by q.canonical_product_id)
                        from public.current_price_quotes q
                        where q.provider_id = p.id and q.status = 'ok'), '[]'::jsonb)
  )
  from public.price_providers p
  where p.code = p_code;
$$;

/** Sağlayıcı listesi + sağlık + son koşum (admin ekranı). */
create or replace function public.price_providers_state()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'code', p.code,
      'displayName', p.display_name,
      'technicalName', p.technical_name,
      'marketId', p.market_id,
      'marketDisplayName', p.market_display_name,
      'providerType', p.provider_type,
      'enabled', p.enabled,
      'userSelectable', p.user_selectable,
      'licenseStatus', p.license_status,
      'licenseReference', p.license_reference,
      'redistributionAllowed', p.redistribution_allowed,
      'capabilities', p.capabilities,
      'attribution', p.attribution,
      'referenceUrl', p.reference_url,
      'coverage', (select count(*)::int from public.current_price_quotes q where q.provider_id = p.id),
      'mappingCount', (select count(*)::int from public.price_product_mappings m
                       where m.provider_id = p.id and m.active),
      'health', (select jsonb_build_object(
                   'status', h.status, 'lastSuccessAt', h.last_success_at, 'lastErrorAt', h.last_error_at,
                   'coverageCount', h.coverage_count, 'staleCount', h.stale_count,
                   'quarantinedCount', h.quarantined_count, 'latencyMs', h.latency_ms,
                   'safeErrorCode', h.safe_error_code)
                 from public.provider_health_snapshots h where h.provider_id = p.id),
      'lastRun', (select jsonb_build_object(
                    'status', r.status, 'startedAt', r.started_at, 'completedAt', r.completed_at,
                    'quoteCount', r.quote_count, 'rejectedCount', r.rejected_count,
                    'latencyMs', r.latency_ms, 'safeErrorCode', r.safe_error_code)
                  from public.price_ingestion_runs r
                  where r.provider_id = p.id order by r.started_at desc limit 1)
    ) order by p.market_id, p.code), '[]'::jsonb)
  from public.price_providers p;
$$;

/** Karşılaştırma: birden çok sağlayıcının aynı ürünlerdeki fiyatları. */
create or replace function public.price_quotes_compare(p_codes text[])
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'providerCode', p.code,
      'displayName', p.display_name,
      'technicalName', p.technical_name,
      'marketId', p.market_id,
      'marketDisplayName', p.market_display_name,
      'licenseStatus', p.license_status,
      'enabled', p.enabled,
      'userSelectable', p.user_selectable,
      'health', (select jsonb_build_object('status', h.status, 'lastSuccessAt', h.last_success_at,
                   'safeErrorCode', h.safe_error_code)
                 from public.provider_health_snapshots h where h.provider_id = p.id),
      'quotes', coalesce((select jsonb_agg(public.price_quote_json(q) order by q.canonical_product_id)
                          from public.current_price_quotes q where q.provider_id = p.id), '[]'::jsonb)
    ) order by p.code), '[]'::jsonb)
  from public.price_providers p
  where p.code = any(p_codes);
$$;

-- -----------------------------------------------------------------------------
-- 5. Kaynak tercihi
-- -----------------------------------------------------------------------------

create or replace function public.price_preference_get(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'portfolioId', pf.id,
    'providerCode', pp.code,
    'marketId', coalesce(pref.selected_market_id, pp.market_id),
    'selectedAt', pref.selected_at,
    'selectedBy', pref.selected_by
  )
  from public.portfolios pf
  left join public.portfolio_price_preferences pref on pref.portfolio_id = pf.id
  left join public.price_providers pp on pp.id = pref.selected_provider_id
  where pf.user_id = p_user_id;
$$;

/**
 * Portföyün fiyat kaynağını değiştirir.
 * - Yalnızca enabled + user_selectable (veya admin işlemi ise enabled) kaynak seçilebilir.
 * - REFERENCE_ONLY kaynak birincil seçilemez.
 * - Her değişiklik price_source_change_events kaydı üretir.
 */
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

create or replace function public.price_source_events(p_user_id uuid, p_limit integer default 50)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'changedAt', e.changed_at,
      'previousProviderCode', (select code from public.price_providers where id = e.previous_provider_id),
      'newProviderCode', (select code from public.price_providers where id = e.new_provider_id),
      'previousMarketId', e.previous_market_id,
      'newMarketId', e.new_market_id,
      'changedByRole', e.changed_by_role,
      'reason', e.reason
    ) order by e.changed_at desc), '[]'::jsonb)
  from (
    select * from public.price_source_change_events
    where user_id = p_user_id order by changed_at desc limit greatest(p_limit, 1)
  ) e;
$$;

-- -----------------------------------------------------------------------------
-- 6. Yetkiler
-- -----------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.price_providers_sync(jsonb)',
    'public.price_mappings_sync(text, text, jsonb)',
    'public.price_provider_set_flags(text, boolean, boolean)',
    'public.price_ingestion_apply(text, text, jsonb)',
    'public.price_quotes_current(text)',
    'public.price_providers_state()',
    'public.price_quotes_compare(text[])',
    'public.price_preference_get(uuid)',
    'public.price_preference_set(uuid, text, uuid, text, text)',
    'public.price_source_events(uuid, integer)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;

  foreach fn in array array[
    'public.price_quote_json(public.current_price_quotes)',
    'public.reject_price_history_mutation()',
    'public.reject_price_source_event_mutation()'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
end;
$$;
