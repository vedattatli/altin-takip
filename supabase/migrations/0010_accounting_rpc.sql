-- =============================================================================
-- Altın Takip — 0010 Muhasebe RPC'leri
--
-- Bütün finansal mutation'lar bu SECURITY DEFINER fonksiyonlardan geçer ve
-- YALNIZCA service_role (BFF) tarafından çağrılabilir. Her mutation:
--   1. kullanıcının portföy satırını FOR UPDATE ile kilitler (lock_user_portfolio),
--   2. portföy + ürün düzeyinde transaction-scoped advisory lock alır,
--   3. idempotency anahtarını uygular (aynı içerik -> aynı sonuç, farklı -> conflict),
--   4. defter kaydını ekler / durumunu değiştirir,
--   5. pozisyonu defterden yeniden oynatarak (rebuild) atomik günceller,
--   6. herhangi bir anda negatif miktar oluşursa ALTIN_OVERSELL ile geri alır.
--
-- Sayısal değerler JSON'a METİN olarak çıkarılır (kayan nokta kaybı olmaz).
-- Algoritma TypeScript motoruyla (src/domain/accounting/engine.ts) birebir aynıdır;
-- `npm run accounting:verify` ikisini karşılaştırır.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. JSON yardımcıları (dahili)
-- -----------------------------------------------------------------------------

/** numeric -> kanonik ondalık metin ("10.000000" -> "10", "5009.52380952" korunur). */
create or replace function public.ledger_num_text(n numeric)
returns text
language sql
immutable
as $$
  select case
    when n is null then null
    when n::text like '%.%' then
      case when rtrim(rtrim(n::text, '0'), '.') in ('', '-') then '0'
           else rtrim(rtrim(n::text, '0'), '.') end
    else n::text
  end;
$$;

create or replace function public.ledger_snapshot_json(s public.price_snapshots)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', s.id,
    'productId', s.product_id,
    'liquidationPrice', public.ledger_num_text(s.liquidation_price),
    'replacementPrice', public.ledger_num_text(s.replacement_price),
    'provider', s.provider,
    'market', s.market,
    'currency', s.currency,
    'providerStatus', s.provider_status,
    'isRealMarketData', s.is_real_market_data,
    'providerTimestamp', s.provider_timestamp,
    'fetchedAt', s.fetched_at,
    'createdAt', s.created_at
  );
$$;

create or replace function public.ledger_transaction_json(t public.transactions)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', t.id,
    'portfolioId', t.portfolio_id,
    'productId', t.product_id,
    'kind', t.transaction_kind,
    'quantity', public.ledger_num_text(t.quantity),
    'unit', t.unit,
    'occurredAt', to_char(t.traded_at, 'YYYY-MM-DD'),
    'pricingInputMode', t.pricing_input_mode,
    'acquisitionUnitPrice', public.ledger_num_text(t.acquisition_unit_price),
    'disposalUnitPrice', public.ledger_num_text(t.disposal_unit_price),
    'grossAmount', public.ledger_num_text(t.gross_amount),
    'fees', public.ledger_num_text(t.fees),
    'workmanship', public.ledger_num_text(t.workmanship),
    'totalPaid', public.ledger_num_text(t.total_paid),
    'netProceeds', public.ledger_num_text(t.net_proceeds),
    'costBasisOrigin', t.cost_basis_origin,
    'priceSnapshotId', t.price_snapshot_id,
    'priceSnapshot', (select public.ledger_snapshot_json(s)
                      from public.price_snapshots s where s.id = t.price_snapshot_id),
    'note', t.note,
    'status', t.status,
    'voidedAt', t.voided_at,
    'voidReason', t.void_reason,
    'replacesTransactionId', t.replaces_transaction_id,
    'replacedByTransactionId', t.replaced_by_transaction_id,
    'clientRequestId', t.client_request_id,
    'ledgerSequence', t.ledger_sequence,
    'createdAt', t.created_at,
    'updatedAt', t.updated_at
  );
$$;

create or replace function public.ledger_position_json(p public.portfolio_positions)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'productId', p.product_id,
    'quantity', public.ledger_num_text(p.quantity),
    'remainingCostBasis', public.ledger_num_text(p.remaining_cost_basis),
    'averageCost', public.ledger_num_text(p.average_cost),
    'realizedPnl', public.ledger_num_text(p.realized_pnl),
    'costOrigins', jsonb_build_object(
      'actual', p.has_actual, 'estimated', p.has_estimated, 'baseline', p.has_baseline),
    'activeTransactionCount', p.active_transaction_count,
    'lastLedgerSequence', p.last_ledger_sequence
  );
$$;

/** Aktif kaydı olmayan ürün için sıfır pozisyon (tek ve belgelenmiş davranış). */
create or replace function public.ledger_empty_position_json(p_product_id text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'productId', p_product_id,
    'quantity', '0',
    'remainingCostBasis', '0',
    'averageCost', null,
    'realizedPnl', '0',
    'costOrigins', jsonb_build_object('actual', false, 'estimated', false, 'baseline', false),
    'activeTransactionCount', 0,
    'lastLedgerSequence', 0
  );
$$;

-- -----------------------------------------------------------------------------
-- 2. Tutar hesabı (dahili) — TypeScript resolveLedgerAmounts ile birebir
-- -----------------------------------------------------------------------------

create or replace function public.ledger_compute_amounts(
  p_kind text,
  p_mode text,
  p_quantity numeric,
  p_unit_price numeric,
  p_total_amount numeric,
  p_fees numeric,
  p_workmanship numeric,
  p_baseline_unit numeric
)
returns jsonb
language plpgsql
immutable
as $$
declare
  fees numeric := coalesce(p_fees, 0);
  work numeric := coalesce(p_workmanship, 0);
  gross numeric;
  total numeric;
  net numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Miktar sıfırdan büyük olmalıdır.' using errcode = 'P0004';
  end if;
  if fees < 0 or work < 0 then
    raise exception 'Masraflar negatif olamaz.' using errcode = 'P0004';
  end if;

  if p_kind = 'SELL' then
    if work <> 0 then
      raise exception 'Satışta işçilik alanı kullanılmaz.' using errcode = 'P0004';
    end if;
    if p_mode = 'UNIT_PRICE' then
      if p_unit_price is null or p_unit_price <= 0 then
        raise exception 'Birim satış fiyatı sıfırdan büyük olmalıdır.' using errcode = 'P0004';
      end if;
      gross := p_quantity * p_unit_price;
      net := gross - fees;
    elsif p_mode = 'TOTAL_AMOUNT' then
      if p_total_amount is null or p_total_amount < 0 then
        raise exception 'Net tahsilat negatif olamaz.' using errcode = 'P0004';
      end if;
      net := p_total_amount;
      gross := net + fees;
    else
      raise exception 'Satışta piyasa başlangıç fiyatı kullanılamaz.' using errcode = 'P0004';
    end if;
    if net < 0 then
      raise exception 'Satış masrafları satış tutarını aşamaz.' using errcode = 'P0004';
    end if;
    return jsonb_build_object(
      'acquisition_unit_price', null,
      'disposal_unit_price', round(gross / p_quantity, 8),
      'gross', gross, 'fees', fees, 'workmanship', 0,
      'total_paid', null, 'net_proceeds', net);
  end if;

  -- BUY / OPENING_BALANCE
  if p_mode = 'MARKET_BASELINE' then
    if p_baseline_unit is null or p_baseline_unit <= 0 then
      raise exception 'Başlangıç fiyatı geçersiz.' using errcode = 'P0004';
    end if;
    gross := p_quantity * p_baseline_unit;
    total := gross;
    fees := 0;
    work := 0;
  elsif p_mode = 'UNIT_PRICE' then
    if p_unit_price is null or p_unit_price <= 0 then
      raise exception 'Birim alış fiyatı sıfırdan büyük olmalıdır.' using errcode = 'P0004';
    end if;
    gross := p_quantity * p_unit_price;
    total := gross + work + fees;
  elsif p_mode = 'TOTAL_AMOUNT' then
    if p_total_amount is null or p_total_amount <= 0 then
      raise exception 'Toplam tutar sıfırdan büyük olmalıdır.' using errcode = 'P0004';
    end if;
    total := p_total_amount;
    gross := total - work - fees;
    if gross < 0 then
      raise exception 'Masraflar toplam ödenen tutarı aşamaz.' using errcode = 'P0004';
    end if;
  else
    raise exception 'Fiyat giriş yöntemi geçersiz.' using errcode = 'P0004';
  end if;

  return jsonb_build_object(
    'acquisition_unit_price', round(total / p_quantity, 8),
    'disposal_unit_price', null,
    'gross', gross, 'fees', fees, 'workmanship', work,
    'total_paid', total, 'net_proceeds', null);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Yeniden oynatma (saf) ve pozisyon yeniden oluşturma (yazar)
-- -----------------------------------------------------------------------------

/**
 * Bir ürünün AKTİF kayıtlarını deterministik sırayla oynatır; hiçbir şey yazmaz.
 * Herhangi bir anda negatif miktar oluşursa ALTIN_OVERSELL (P0001) fırlatır.
 */
create or replace function public.ledger_replay_product(p_user_id uuid, p_product_id text)
returns jsonb
language plpgsql
stable
as $$
declare
  running_qty numeric := 0;
  running_cost numeric := 0;
  realized numeric := 0;
  removed numeric;
  flag_actual boolean := false;
  flag_estimated boolean := false;
  flag_baseline boolean := false;
  cnt integer := 0;
  last_seq bigint := 0;
  r record;
begin
  for r in
    select transaction_kind, quantity, total_paid, net_proceeds, cost_basis_origin, ledger_sequence
    from public.transactions
    where user_id = p_user_id and product_id = p_product_id and status = 'ACTIVE'
    order by traded_at, created_at, ledger_sequence, id
  loop
    cnt := cnt + 1;
    last_seq := greatest(last_seq, r.ledger_sequence);

    if r.transaction_kind in ('BUY', 'OPENING_BALANCE') then
      running_qty := running_qty + r.quantity;
      running_cost := running_cost + coalesce(r.total_paid, 0);
      if r.cost_basis_origin = 'ACTUAL' then flag_actual := true; end if;
      if r.cost_basis_origin = 'ESTIMATED' then flag_estimated := true; end if;
      if r.cost_basis_origin = 'MARKET_BASELINE' then flag_baseline := true; end if;
    else
      if r.quantity > running_qty then
        raise exception 'ALTIN_OVERSELL: % ürününde satış eldeki miktarı aşıyor (mevcut %, istenen %).',
          p_product_id, public.ledger_num_text(running_qty), public.ledger_num_text(r.quantity)
          using errcode = 'P0001';
      end if;
      if r.quantity = running_qty then
        removed := running_cost;
      else
        removed := round(running_cost * r.quantity / running_qty, 8);
      end if;
      realized := realized + coalesce(r.net_proceeds, 0) - removed;
      running_qty := running_qty - r.quantity;
      running_cost := running_cost - removed;
      if running_qty = 0 then
        running_cost := 0;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'productId', p_product_id,
    'quantity', public.ledger_num_text(running_qty),
    'remainingCostBasis', public.ledger_num_text(running_cost),
    'averageCost', case when running_qty > 0
                        then public.ledger_num_text(round(running_cost / running_qty, 8))
                        else null end,
    'realizedPnl', public.ledger_num_text(realized),
    'costOrigins', jsonb_build_object(
      'actual', flag_actual, 'estimated', flag_estimated, 'baseline', flag_baseline),
    'activeTransactionCount', cnt,
    'lastLedgerSequence', last_seq
  );
end;
$$;

/** Pozisyon projeksiyonunu defterden yeniden oluşturur (çağıran taraf kilit almış olmalıdır). */
create or replace function public.ledger_rebuild_position(p_user_id uuid, p_product_id text)
returns jsonb
language plpgsql
as $$
declare
  replayed jsonb;
  pid uuid;
begin
  replayed := public.ledger_replay_product(p_user_id, p_product_id);

  select id into pid from public.portfolios where user_id = p_user_id;
  if pid is null then
    raise exception 'ALTIN_PORTFOLIO_NOT_PROVISIONED: % kullanıcısının portföyü yok.', p_user_id
      using errcode = 'P0002';
  end if;

  if (replayed->>'activeTransactionCount')::integer = 0 then
    delete from public.portfolio_positions
    where user_id = p_user_id and product_id = p_product_id;
    return public.ledger_empty_position_json(p_product_id);
  end if;

  insert into public.portfolio_positions as pp
    (portfolio_id, user_id, product_id, quantity, remaining_cost_basis, average_cost, realized_pnl,
     has_actual, has_estimated, has_baseline, active_transaction_count, last_ledger_sequence, updated_at)
  values
    (pid, p_user_id, p_product_id,
     (replayed->>'quantity')::numeric,
     (replayed->>'remainingCostBasis')::numeric,
     (replayed->>'averageCost')::numeric,
     (replayed->>'realizedPnl')::numeric,
     (replayed->'costOrigins'->>'actual')::boolean,
     (replayed->'costOrigins'->>'estimated')::boolean,
     (replayed->'costOrigins'->>'baseline')::boolean,
     (replayed->>'activeTransactionCount')::integer,
     (replayed->>'lastLedgerSequence')::bigint,
     now())
  on conflict (portfolio_id, product_id) do update set
    quantity = excluded.quantity,
    remaining_cost_basis = excluded.remaining_cost_basis,
    average_cost = excluded.average_cost,
    realized_pnl = excluded.realized_pnl,
    has_actual = excluded.has_actual,
    has_estimated = excluded.has_estimated,
    has_baseline = excluded.has_baseline,
    active_transaction_count = excluded.active_transaction_count,
    last_ledger_sequence = excluded.last_ledger_sequence,
    updated_at = now();

  return replayed;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Mutation RPC'leri (service_role)
-- -----------------------------------------------------------------------------

/**
 * Yeni defter kaydı. p_payload anahtarları:
 *   kind, product_id, quantity, unit, occurred_at, pricing_input_mode, unit_price,
 *   total_amount, fees, workmanship, cost_basis_origin, note, client_request_id,
 *   created_by, baseline_snapshot { liquidation_price, replacement_price, provider,
 *   market, currency, provider_status, is_real_market_data, provider_timestamp, fetched_at }
 * Sayısal alanlar METİN olarak gelir.
 */
create or replace function public.ledger_append(p_user_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := p_payload->>'kind';
  v_product text := p_payload->>'product_id';
  v_qty numeric := (p_payload->>'quantity')::numeric;
  v_unit text := p_payload->>'unit';
  v_occurred date := (p_payload->>'occurred_at')::date;
  v_mode text := p_payload->>'pricing_input_mode';
  v_unit_price numeric := (p_payload->>'unit_price')::numeric;
  v_total numeric := (p_payload->>'total_amount')::numeric;
  v_fees numeric := coalesce((p_payload->>'fees')::numeric, 0);
  v_work numeric := coalesce((p_payload->>'workmanship')::numeric, 0);
  v_origin text := coalesce(p_payload->>'cost_basis_origin', 'ACTUAL');
  v_note text := coalesce(p_payload->>'note', '');
  v_req text := nullif(p_payload->>'client_request_id', '');
  v_created_by uuid := coalesce((p_payload->>'created_by')::uuid, p_user_id);
  v_replaces uuid := (p_payload->>'replaces_transaction_id')::uuid;
  v_snapshot jsonb := p_payload->'baseline_snapshot';
  v_snapshot_id uuid;
  v_baseline numeric;
  v_hash text;
  amounts jsonb;
  pid uuid;
  existing public.transactions;
  created public.transactions;
  pos jsonb;
begin
  if v_kind not in ('OPENING_BALANCE', 'BUY', 'SELL') then
    raise exception 'İşlem türü geçersiz.' using errcode = 'P0004';
  end if;
  if v_origin not in ('ACTUAL', 'ESTIMATED', 'MARKET_BASELINE') then
    raise exception 'Maliyet kökeni geçersiz.' using errcode = 'P0004';
  end if;
  if v_kind = 'SELL' and v_origin <> 'ACTUAL' then
    raise exception 'Satışta maliyet kökeni belirtilmez.' using errcode = 'P0004';
  end if;
  if (v_origin = 'MARKET_BASELINE') <> (v_mode = 'MARKET_BASELINE') then
    raise exception 'Piyasa başlangıcı yalnızca MARKET_BASELINE modunda kullanılabilir.' using errcode = 'P0004';
  end if;
  if v_origin = 'MARKET_BASELINE' and v_kind <> 'OPENING_BALANCE' then
    raise exception 'Piyasa başlangıcı yalnızca mevcut altın (açılış bakiyesi) için kullanılabilir.' using errcode = 'P0004';
  end if;
  if v_occurred > current_date then
    raise exception 'İşlem tarihi gelecekte olamaz.' using errcode = 'P0004';
  end if;
  if char_length(v_note) > 280 then
    raise exception 'Not en fazla 280 karakter olabilir.' using errcode = 'P0004';
  end if;
  if not exists (select 1 from public.gold_products where id = v_product) then
    raise exception 'Bilinmeyen altın ürünü: %', v_product using errcode = 'P0004';
  end if;

  pid := public.lock_user_portfolio(p_user_id);
  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || v_product)::bigint);

  -- Idempotency: aynı anahtar + aynı içerik -> mevcut sonuç; farklı içerik -> conflict.
  v_hash := md5((p_payload - 'client_request_id' - 'baseline_snapshot' - 'created_by')::text);
  if v_req is not null then
    select * into existing
    from public.transactions
    where user_id = p_user_id and client_request_id = v_req;
    if found then
      if existing.request_hash is distinct from v_hash then
        raise exception 'ALTIN_IDEMPOTENCY_CONFLICT: % anahtarı farklı içerikle kullanılmış.', v_req
          using errcode = 'P0003';
      end if;
      select public.ledger_position_json(pp) into pos
      from public.portfolio_positions pp
      where pp.user_id = p_user_id and pp.product_id = existing.product_id;
      return jsonb_build_object(
        'transaction', public.ledger_transaction_json(existing),
        'position', coalesce(pos, public.ledger_empty_position_json(existing.product_id)),
        'replayed', true);
    end if;
  end if;

  -- MARKET_BASELINE: sunucunun verdiği fiyat anlık görüntüsü aynı işlem içinde saklanır.
  if v_origin = 'MARKET_BASELINE' then
    if v_snapshot is null then
      raise exception 'Başlangıç fiyatı anlık görüntüsü eksik.' using errcode = 'P0004';
    end if;
    if coalesce(v_snapshot->>'provider_status', '') <> 'ok' then
      raise exception 'Fiyat verisi kullanılamıyor; takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
    end if;
    insert into public.price_snapshots
      (user_id, product_id, liquidation_price, replacement_price, provider, market, currency,
       provider_status, is_real_market_data, provider_timestamp, fetched_at)
    values
      (p_user_id, v_product,
       (v_snapshot->>'liquidation_price')::numeric,
       (v_snapshot->>'replacement_price')::numeric,
       v_snapshot->>'provider', v_snapshot->>'market', coalesce(v_snapshot->>'currency', 'TRY'),
       v_snapshot->>'provider_status',
       coalesce((v_snapshot->>'is_real_market_data')::boolean, false),
       (v_snapshot->>'provider_timestamp')::timestamptz,
       (v_snapshot->>'fetched_at')::timestamptz)
    returning id, liquidation_price into v_snapshot_id, v_baseline;
  end if;

  amounts := public.ledger_compute_amounts(
    v_kind, v_mode, v_qty, v_unit_price, v_total, v_fees, v_work, v_baseline);

  insert into public.transactions
    (user_id, portfolio_id, product_id, side, transaction_kind, quantity, unit, traded_at,
     unit_price, fee_amount, note, pricing_input_mode, acquisition_unit_price, disposal_unit_price,
     gross_amount, fees, workmanship, total_paid, net_proceeds, cost_basis_origin, price_snapshot_id,
     status, created_by, client_request_id, request_hash, replaces_transaction_id)
  values
    (p_user_id, pid, v_product,
     case when v_kind = 'SELL' then 'sell' else 'buy' end,
     v_kind, v_qty, v_unit, v_occurred,
     coalesce((amounts->>'acquisition_unit_price')::numeric, (amounts->>'disposal_unit_price')::numeric, 0),
     (amounts->>'fees')::numeric,
     v_note, v_mode,
     (amounts->>'acquisition_unit_price')::numeric,
     (amounts->>'disposal_unit_price')::numeric,
     (amounts->>'gross')::numeric,
     (amounts->>'fees')::numeric,
     (amounts->>'workmanship')::numeric,
     (amounts->>'total_paid')::numeric,
     (amounts->>'net_proceeds')::numeric,
     v_origin, v_snapshot_id, 'ACTIVE', v_created_by, v_req, v_hash, v_replaces)
  returning * into created;

  -- Pozisyon aynı transaction içinde yeniden oluşturulur; oversell tüm işlemi geri alır.
  pos := public.ledger_rebuild_position(p_user_id, v_product);

  return jsonb_build_object(
    'transaction', public.ledger_transaction_json(created),
    'position', pos,
    'replayed', false);
end;
$$;

/** Kaydı iptal eder (VOID). Sonraki bir satış negatife düşerse tüm işlem reddedilir. */
create or replace function public.ledger_void(p_user_id uuid, p_transaction_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.transactions;
  updated public.transactions;
  pos jsonb;
begin
  perform public.lock_user_portfolio(p_user_id);

  select * into target from public.transactions
  where id = p_transaction_id and user_id = p_user_id;
  if not found then
    raise exception 'İşlem bulunamadı.' using errcode = 'P0002';
  end if;
  if target.status <> 'ACTIVE' then
    raise exception 'ALTIN_LEDGER_NOT_ACTIVE: işlem zaten iptal edilmiş veya düzeltilmiş.' using errcode = 'P0005';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || target.product_id)::bigint);

  update public.transactions
  set status = 'VOID',
      voided_at = now(),
      void_reason = left(coalesce(nullif(p_reason, ''), 'Kullanıcı iptal etti'), 140)
  where id = p_transaction_id
  returning * into updated;

  pos := public.ledger_rebuild_position(p_user_id, target.product_id);

  return jsonb_build_object(
    'transaction', public.ledger_transaction_json(updated),
    'position', pos);
end;
$$;

/** Kaydı düzeltir: eski kayıt REPLACED olur, yerine yeni kayıt eklenir; tek işlem. */
create or replace function public.ledger_replace(p_user_id uuid, p_transaction_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.transactions;
  voided public.transactions;
  appended jsonb;
  created_id uuid;
  created public.transactions;
  v_req text := nullif(p_payload->>'client_request_id', '');
  -- Yeni kayıt "neyi düzelttiğini" INSERT anında taşır (guard sonradan değiştirmeye izin vermez).
  v_payload jsonb := p_payload || jsonb_build_object('replaces_transaction_id', p_transaction_id::text);
  existing public.transactions;
  positions jsonb := '[]'::jsonb;
  new_product text := p_payload->>'product_id';
begin
  perform public.lock_user_portfolio(p_user_id);

  select * into target from public.transactions
  where id = p_transaction_id and user_id = p_user_id;
  if not found then
    raise exception 'İşlem bulunamadı.' using errcode = 'P0002';
  end if;

  -- Idempotent tekrar: aynı istek kimliğiyle daha önce yapılmış düzeltme.
  if v_req is not null then
    select * into existing from public.transactions
    where user_id = p_user_id and client_request_id = v_req;
    if found then
      if existing.replaces_transaction_id is distinct from p_transaction_id then
        raise exception 'ALTIN_IDEMPOTENCY_CONFLICT: % anahtarı farklı içerikle kullanılmış.', v_req
          using errcode = 'P0003';
      end if;
      -- İçerik karşılaştırması ledger_append tarafından yapılır (replay döner veya conflict).
      appended := public.ledger_append(p_user_id, v_payload);
      select * into voided from public.transactions where id = p_transaction_id;
      return jsonb_build_object(
        'voided', public.ledger_transaction_json(voided),
        'transaction', appended->'transaction',
        'positions', jsonb_build_array(appended->'position'),
        'replayed', true);
    end if;
  end if;

  if target.status <> 'ACTIVE' then
    raise exception 'ALTIN_LEDGER_NOT_ACTIVE: işlem zaten iptal edilmiş veya düzeltilmiş.' using errcode = 'P0005';
  end if;
  if new_product is null or new_product = '' then
    raise exception 'Bilinmeyen altın ürünü.' using errcode = 'P0004';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || target.product_id)::bigint);
  if new_product <> target.product_id then
    perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || new_product)::bigint);
  end if;

  -- Önce eski kayıt REPLACED olur (aksi hâlde yeni kayıt eski aktif kayıtla birlikte oynatılırdı).
  update public.transactions
  set status = 'REPLACED',
      voided_at = now(),
      void_reason = 'Düzeltildi'
  where id = p_transaction_id;

  appended := public.ledger_append(p_user_id, v_payload);
  created_id := (appended->'transaction'->>'id')::uuid;

  -- Eski kayda "neyle düzeltildiği" yazılır (guard bu alana izin verir).
  update public.transactions
  set replaced_by_transaction_id = created_id
  where id = p_transaction_id
  returning * into voided;

  select * into created from public.transactions where id = created_id;

  if created.product_id <> target.product_id then
    positions := positions
      || public.ledger_rebuild_position(p_user_id, target.product_id)
      || public.ledger_rebuild_position(p_user_id, created.product_id);
  else
    positions := positions || public.ledger_rebuild_position(p_user_id, created.product_id);
  end if;

  return jsonb_build_object(
    'voided', public.ledger_transaction_json(voided),
    'transaction', public.ledger_transaction_json(created),
    'positions', positions,
    'replayed', false);
end;
$$;

/** Tüm aktif kayıtları iptal eder. */
create or replace function public.ledger_void_all(p_user_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
  product text;
begin
  perform public.lock_user_portfolio(p_user_id);

  update public.transactions
  set status = 'VOID',
      voided_at = now(),
      void_reason = left(coalesce(nullif(p_reason, ''), 'Kullanıcı iptal etti'), 140)
  where user_id = p_user_id and status = 'ACTIVE';
  get diagnostics affected = row_count;

  for product in
    select distinct product_id from public.portfolio_positions where user_id = p_user_id
  loop
    perform public.ledger_rebuild_position(p_user_id, product);
  end loop;

  return affected;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Okuma RPC'leri (service_role) — hiçbir şey yazmaz
-- -----------------------------------------------------------------------------

create or replace function public.ledger_list(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(public.ledger_transaction_json(t)
              order by t.traded_at desc, t.created_at desc, t.ledger_sequence desc),
    '[]'::jsonb)
  from public.transactions t
  where t.user_id = p_user_id;
$$;

create or replace function public.positions_list(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(public.ledger_position_json(p) order by p.product_id),
    '[]'::jsonb)
  from public.portfolio_positions p
  where p.user_id = p_user_id;
$$;

/** Defteri yeniden oynatıp türetilmiş pozisyonlarla karşılaştırır; tutarsızlıkları döner. */
create or replace function public.ledger_verify(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  product text;
  replayed jsonb;
  stored public.portfolio_positions;
  checked integer := 0;
  mismatches jsonb := '[]'::jsonb;
  field text;
  stored_value text;
  replayed_value text;
begin
  for product in
    select distinct product_id from public.transactions where user_id = p_user_id and status = 'ACTIVE'
    union
    select distinct product_id from public.portfolio_positions where user_id = p_user_id
  loop
    checked := checked + 1;
    replayed := public.ledger_replay_product(p_user_id, product);
    select * into stored from public.portfolio_positions
    where user_id = p_user_id and product_id = product;

    if not found then
      if (replayed->>'activeTransactionCount')::integer > 0 then
        mismatches := mismatches || jsonb_build_object(
          'productId', product, 'field', 'row', 'stored', null, 'recomputed', 'present');
      end if;
      continue;
    end if;

    foreach field in array array['quantity', 'remainingCostBasis', 'averageCost', 'realizedPnl'] loop
      stored_value := case field
        when 'quantity' then public.ledger_num_text(stored.quantity)
        when 'remainingCostBasis' then public.ledger_num_text(stored.remaining_cost_basis)
        when 'averageCost' then public.ledger_num_text(stored.average_cost)
        else public.ledger_num_text(stored.realized_pnl) end;
      replayed_value := replayed->>field;
      if stored_value is distinct from replayed_value then
        mismatches := mismatches || jsonb_build_object(
          'productId', product, 'field', field, 'stored', stored_value, 'recomputed', replayed_value);
      end if;
    end loop;

    if stored.active_transaction_count <> (replayed->>'activeTransactionCount')::integer then
      mismatches := mismatches || jsonb_build_object(
        'productId', product, 'field', 'activeTransactionCount',
        'stored', stored.active_transaction_count::text,
        'recomputed', replayed->>'activeTransactionCount');
    end if;
  end loop;

  return jsonb_build_object('checked', checked, 'mismatches', mismatches);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Eski RPC'ler yeni deftere yönlendirilir (imza ve yetkiler korunur)
-- -----------------------------------------------------------------------------

/** Yalnızca AKTİF kayıtlara bakar (VOID/REPLACED sayılmaz). */
create or replace function public.assert_no_oversell(p_user_id uuid, p_product_id text)
returns void
language plpgsql
as $$
begin
  perform public.ledger_replay_product(p_user_id, p_product_id);
end;
$$;

create or replace function public.create_transaction_checked(
  p_user_id uuid,
  p_product_id text,
  p_side text,
  p_quantity numeric,
  p_unit text,
  p_traded_at date,
  p_unit_price numeric,
  p_fee_amount numeric,
  p_note text
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  created public.transactions;
begin
  result := public.ledger_append(p_user_id, jsonb_build_object(
    'kind', case when p_side = 'sell' then 'SELL' else 'BUY' end,
    'product_id', p_product_id,
    'quantity', p_quantity::text,
    'unit', p_unit,
    'occurred_at', p_traded_at::text,
    'pricing_input_mode', 'UNIT_PRICE',
    'unit_price', p_unit_price::text,
    'total_amount', null,
    'fees', coalesce(p_fee_amount, 0)::text,
    'workmanship', '0',
    'cost_basis_origin', 'ACTUAL',
    'note', coalesce(p_note, ''),
    'client_request_id', null));
  select * into created from public.transactions
  where id = (result->'transaction'->>'id')::uuid;
  return created;
end;
$$;

create or replace function public.update_transaction_checked(
  p_user_id uuid,
  p_transaction_id uuid,
  p_product_id text,
  p_side text,
  p_quantity numeric,
  p_unit text,
  p_traded_at date,
  p_unit_price numeric,
  p_fee_amount numeric,
  p_note text
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  created public.transactions;
begin
  result := public.ledger_replace(p_user_id, p_transaction_id, jsonb_build_object(
    'kind', case when p_side = 'sell' then 'SELL' else 'BUY' end,
    'product_id', p_product_id,
    'quantity', p_quantity::text,
    'unit', p_unit,
    'occurred_at', p_traded_at::text,
    'pricing_input_mode', 'UNIT_PRICE',
    'unit_price', p_unit_price::text,
    'total_amount', null,
    'fees', coalesce(p_fee_amount, 0)::text,
    'workmanship', '0',
    'cost_basis_origin', 'ACTUAL',
    'note', coalesce(p_note, ''),
    'client_request_id', null));
  select * into created from public.transactions
  where id = (result->'transaction'->>'id')::uuid;
  return created;
end;
$$;

create or replace function public.delete_transaction_checked(
  p_user_id uuid,
  p_transaction_id uuid
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  voided public.transactions;
begin
  result := public.ledger_void(p_user_id, p_transaction_id, 'Kullanıcı iptal etti');
  select * into voided from public.transactions where id = p_transaction_id;
  return voided;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Yetkiler — üst seviye RPC'ler yalnızca service_role; yardımcılar hiçbir role
-- -----------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.ledger_append(uuid, jsonb)',
    'public.ledger_void(uuid, uuid, text)',
    'public.ledger_replace(uuid, uuid, jsonb)',
    'public.ledger_void_all(uuid, text)',
    'public.ledger_list(uuid)',
    'public.positions_list(uuid)',
    'public.ledger_verify(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;

  foreach fn in array array[
    'public.ledger_num_text(numeric)',
    'public.ledger_snapshot_json(public.price_snapshots)',
    'public.ledger_transaction_json(public.transactions)',
    'public.ledger_position_json(public.portfolio_positions)',
    'public.ledger_empty_position_json(text)',
    'public.ledger_compute_amounts(text, text, numeric, numeric, numeric, numeric, numeric, numeric)',
    'public.ledger_replay_product(uuid, text)',
    'public.ledger_rebuild_position(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
end;
$$;
