-- =============================================================================
-- Altın Takip — 0012 Staging / senkronizasyon sürümü ve son doğruluk düzeltmeleri (Sprint 2)
--
-- 1. DEFTER SÜRÜMÜ (cihazlar arası senkronizasyon sinyali):
--    portfolios.ledger_revision / ledger_updated_at. Gerçek değişiklik üreten
--    ledger_append / ledger_void / ledger_replace / ledger_void_all AYNI transaction
--    içinde artırır; idempotent replay ve başarısız işlem artırmaz. Elle
--    değiştirilemez (tetikleyici); yalnızca RPC içindeki ledger_bump_revision yazar.
--    ledger_revision(uuid) RPC'si yalnızca service_role'a açıktır.
-- 2. SAYISAL SINIRLAR: tutarlar ve türetilmiş birim değerler (total/quantity, net/quantity)
--    en fazla 12 tam basamak; aksi hâlde P0004 (numeric(20,8) taşması olmaz). Sayısal
--    metinler sıkı desenle ayrıştırılır (bilimsel gösterim, NaN, boşluk → P0004);
--    UUID/numeric cast hataları kontrolsüz 22P02 yerine P0004 üretir.
-- 3. ANLIK GÖRÜNTÜ DOĞRULAMASI: provider_timestamp da tazelik sınırına tabidir;
--    fetched_at provider_timestamp'tan (toleransın ötesinde) önce olamaz; istemcinin
--    ilettiği stale_after_ms ile 15 dk'nın küçüğü uygulanır (TypeScript ile aynı sonuç).
-- 4. REPLACE REPLAY: aynı istek kimliğiyle tekrarlanan düzeltme, ilk yanıtla AYNI biçimde
--    [eski ürün pozisyonu, (farklıysa) yeni ürün pozisyonu] döner.
--
-- Eski migration'lar değiştirilmez; bu dosya tekrar çalıştırılabilir (idempotent).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. portfolios: defter sürümü
-- -----------------------------------------------------------------------------

alter table public.portfolios
  add column if not exists ledger_revision bigint not null default 0,
  add column if not exists ledger_updated_at timestamptz not null default now();

comment on column public.portfolios.ledger_revision is
  'Defter değişiklik sinyali (artan). İşlem sayısı DEĞİLDİR; yalnızca RPC içinde ledger_bump_revision artırır.';
comment on column public.portfolios.ledger_updated_at is
  'Defterde son gerçek değişikliğin zamanı (ledger_bump_revision).';

/** Sürüm alanları yalnızca RPC içinden (oturum bayrağıyla) değişebilir; elle yazma reddedilir. */
create or replace function public.guard_portfolio_revision()
returns trigger
language plpgsql
as $$
begin
  if new.ledger_revision is distinct from old.ledger_revision
     or new.ledger_updated_at is distinct from old.ledger_updated_at then
    if coalesce(current_setting('altin.ledger_bump', true), '') <> '1' then
      raise exception 'Defter sürümü elle değiştirilemez; yalnızca defter RPC''leri günceller.'
        using errcode = '42501';
    end if;
    if new.ledger_revision < old.ledger_revision then
      raise exception 'Defter sürümü geriye alınamaz.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists portfolios_guard_revision on public.portfolios;
create trigger portfolios_guard_revision
  before update on public.portfolios
  for each row execute function public.guard_portfolio_revision();

/** Gerçek defter değişikliğinde sürümü artırır (dahili; hiçbir role açık değil). */
create or replace function public.ledger_bump_revision(p_user_id uuid)
returns bigint
language plpgsql
as $$
declare
  rev bigint;
begin
  perform set_config('altin.ledger_bump', '1', true);
  update public.portfolios
  set ledger_revision = ledger_revision + 1,
      ledger_updated_at = now()
  where user_id = p_user_id
  returning ledger_revision into rev;
  perform set_config('altin.ledger_bump', '', true);
  if rev is null then
    raise exception 'ALTIN_PORTFOLIO_NOT_PROVISIONED: % kullanıcısının portföyü yok.', p_user_id
      using errcode = 'P0002';
  end if;
  return rev;
end;
$$;

/** Kullanıcının defter sürümü (service_role). Salt okuma. */
create or replace function public.ledger_revision(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object('revision', p.ledger_revision, 'updatedAt', p.ledger_updated_at)
  from public.portfolios p
  where p.user_id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tutar hesabı: sayısal üst sınır (numeric(20,8) ile uyumlu)
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
  max_amount constant numeric := 1000000000000; -- 10^12: en fazla 12 tam basamak
  too_large constant text :=
    'Tutar veya birim değer beklenenden çok büyük (en fazla 12 tam basamak). Miktar ve tutarı kontrol edin.';
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Miktar sıfırdan büyük olmalıdır.' using errcode = 'P0004';
  end if;
  if p_quantity >= max_amount then
    raise exception 'Miktar beklenenden çok büyük.' using errcode = 'P0004';
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
    if gross >= max_amount or net >= max_amount or fees >= max_amount
       or round(net / p_quantity, 8) >= max_amount or round(gross / p_quantity, 8) >= max_amount then
      raise exception '%', too_large using errcode = 'P0004';
    end if;
    return jsonb_build_object(
      'quoted_acquisition_unit_price', null,
      'quoted_disposal_unit_price', case when p_mode = 'UNIT_PRICE' then p_unit_price else null end,
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

  if gross >= max_amount or total >= max_amount or fees >= max_amount or work >= max_amount
     or round(total / p_quantity, 8) >= max_amount then
    raise exception '%', too_large using errcode = 'P0004';
  end if;

  return jsonb_build_object(
    'quoted_acquisition_unit_price',
      case when p_mode = 'MARKET_BASELINE' then p_baseline_unit
           when p_mode = 'UNIT_PRICE' then p_unit_price else null end,
    'quoted_disposal_unit_price', null,
    'gross', gross, 'fees', fees, 'workmanship', work,
    'total_paid', total, 'net_proceeds', null);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Sayısal metin ayrıştırma (dahili): sıkı desen, kontrolsüz cast yok
-- -----------------------------------------------------------------------------

create or replace function public.ledger_parse_numeric(p_text text, p_label text)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_text is null or p_text = '' then
    return null;
  end if;
  if p_text !~ '^\d{1,20}(\.\d{1,12})?$' then
    raise exception '% için geçerli bir sayı girin.', p_label using errcode = 'P0004';
  end if;
  return p_text::numeric;
end;
$$;

create or replace function public.ledger_parse_uuid(p_text text, p_label text)
returns uuid
language plpgsql
immutable
as $$
begin
  if p_text is null or p_text = '' then
    return null;
  end if;
  if p_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '% için geçerli bir kimlik gerekir.', p_label using errcode = 'P0004';
  end if;
  return p_text::uuid;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3b. Yeniden oynatma: birikimli miktar/maliyet/K-Z de 12 basamağı aşamaz (projeksiyon taşmaz)
-- -----------------------------------------------------------------------------

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
  hold_actual boolean := false;
  hold_estimated boolean := false;
  hold_baseline boolean := false;
  real_actual boolean := false;
  real_estimated boolean := false;
  real_baseline boolean := false;
  cnt integer := 0;
  last_seq bigint := 0;
  max_amount constant numeric := 1000000000000;
  r record;
begin
  for r in
    select transaction_kind, quantity, total_paid, net_proceeds, cost_basis_origin, ledger_sequence
    from public.transactions
    where user_id = p_user_id and product_id = p_product_id and status = 'ACTIVE'
    order by occurred_at, created_at, ledger_sequence, id
  loop
    cnt := cnt + 1;
    last_seq := greatest(last_seq, r.ledger_sequence);

    if r.transaction_kind in ('BUY', 'OPENING_BALANCE') then
      running_qty := running_qty + r.quantity;
      running_cost := running_cost + coalesce(r.total_paid, 0);
      if running_qty >= max_amount or running_cost >= max_amount then
        raise exception 'Tutar veya birim değer beklenenden çok büyük (en fazla 12 tam basamak). Miktar ve tutarı kontrol edin.'
          using errcode = 'P0004';
      end if;
      if r.cost_basis_origin = 'ACTUAL' then hold_actual := true; end if;
      if r.cost_basis_origin = 'ESTIMATED' then hold_estimated := true; end if;
      if r.cost_basis_origin = 'MARKET_BASELINE' then hold_baseline := true; end if;
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
      if abs(realized) >= max_amount then
        raise exception 'Tutar veya birim değer beklenenden çok büyük (en fazla 12 tam basamak). Miktar ve tutarı kontrol edin.'
          using errcode = 'P0004';
      end if;
      real_actual := real_actual or hold_actual;
      real_estimated := real_estimated or hold_estimated;
      real_baseline := real_baseline or hold_baseline;
      running_qty := running_qty - r.quantity;
      running_cost := running_cost - removed;
      if running_qty = 0 then
        running_cost := 0;
        hold_actual := false;
        hold_estimated := false;
        hold_baseline := false;
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
    'holdingCostOrigins', jsonb_build_object(
      'actual', hold_actual, 'estimated', hold_estimated, 'baseline', hold_baseline),
    'realizedPnlOrigins', jsonb_build_object(
      'actual', real_actual, 'estimated', real_estimated, 'baseline', real_baseline),
    'activeTransactionCount', cnt,
    'lastLedgerSequence', last_seq
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. ledger_append: sürüm artışı, sıkı ayrıştırma, anlık görüntü zaman kuralları
-- -----------------------------------------------------------------------------

create or replace function public.ledger_append(p_user_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := p_payload->>'kind';
  v_product text := p_payload->>'product_id';
  v_qty numeric;
  v_unit text := p_payload->>'unit';
  v_occurred_text text := p_payload->>'occurred_at';
  v_time_text text := nullif(p_payload->>'occurred_time', '');
  v_occurred date;
  v_time time(0);
  v_instant timestamptz;
  v_mode text := p_payload->>'pricing_input_mode';
  v_unit_price numeric;
  v_total numeric;
  v_fees numeric;
  v_work numeric;
  v_origin text := coalesce(p_payload->>'cost_basis_origin', 'ACTUAL');
  v_note text := coalesce(p_payload->>'note', '');
  v_req text := nullif(p_payload->>'client_request_id', '');
  v_created_by uuid;
  v_replaces uuid;
  v_snapshot jsonb := p_payload->'baseline_snapshot';
  v_snapshot_id uuid;
  v_baseline numeric;
  v_liq numeric;
  v_rep numeric;
  v_provider_ts timestamptz;
  v_fetched_at timestamptz;
  v_stale_ms numeric;
  v_max_age interval;
  v_hash text;
  amounts jsonb;
  pid uuid;
  existing public.transactions;
  created public.transactions;
  pos jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Geçersiz işlem verisi.' using errcode = 'P0004';
  end if;
  if v_kind not in ('OPENING_BALANCE', 'BUY', 'SELL') then
    raise exception 'İşlem türü geçersiz.' using errcode = 'P0004';
  end if;
  if v_origin not in ('ACTUAL', 'ESTIMATED', 'MARKET_BASELINE') then
    raise exception 'Maliyet kökeni geçersiz.' using errcode = 'P0004';
  end if;
  if v_kind = 'SELL' and v_origin <> 'ACTUAL' then
    raise exception 'Satışta maliyet kökeni belirtilmez.' using errcode = 'P0004';
  end if;
  if v_mode not in ('UNIT_PRICE', 'TOTAL_AMOUNT', 'MARKET_BASELINE') then
    raise exception 'Fiyat giriş yöntemi geçersiz.' using errcode = 'P0004';
  end if;
  if (v_origin = 'MARKET_BASELINE') <> (v_mode = 'MARKET_BASELINE') then
    raise exception 'Piyasa başlangıcı yalnızca MARKET_BASELINE modunda kullanılabilir.' using errcode = 'P0004';
  end if;
  if v_origin = 'MARKET_BASELINE' and v_kind <> 'OPENING_BALANCE' then
    raise exception 'Piyasa başlangıcı yalnızca mevcut altın (açılış bakiyesi) için kullanılabilir.' using errcode = 'P0004';
  end if;

  -- Sayısal ve kimlik alanları kontrolsüz cast'e gitmez (22P02 yerine P0004).
  v_qty := public.ledger_parse_numeric(p_payload->>'quantity', 'Miktar');
  v_unit_price := public.ledger_parse_numeric(p_payload->>'unit_price', 'Birim fiyat');
  v_total := public.ledger_parse_numeric(p_payload->>'total_amount', 'Toplam tutar');
  v_fees := coalesce(public.ledger_parse_numeric(p_payload->>'fees', 'Masraf'), 0);
  v_work := coalesce(public.ledger_parse_numeric(p_payload->>'workmanship', 'İşçilik'), 0);
  v_created_by := coalesce(public.ledger_parse_uuid(p_payload->>'created_by', 'Oluşturan'), p_user_id);
  v_replaces := public.ledger_parse_uuid(p_payload->>'replaces_transaction_id', 'Düzeltilen kayıt');

  -- Tarih: gerçek takvim günü (2026-02-30 reddedilir; artık yıl doğru uygulanır).
  if v_occurred_text is null or v_occurred_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Geçerli bir işlem tarihi seçin.' using errcode = 'P0004';
  end if;
  begin
    v_occurred := v_occurred_text::date;
  exception when others then
    raise exception 'Geçerli bir işlem tarihi seçin (takvimde olmayan gün girilemez).' using errcode = 'P0004';
  end;
  if v_time_text is not null then
    if v_time_text !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      raise exception 'Saat SS:DD biçiminde olmalıdır.' using errcode = 'P0004';
    end if;
    v_time := v_time_text::time(0);
  end if;
  v_instant := ((v_occurred + coalesce(v_time, time '00:00'))::timestamp) at time zone 'Europe/Istanbul';
  if v_occurred > (now() at time zone 'Europe/Istanbul')::date then
    raise exception 'İşlem tarihi gelecekte olamaz.' using errcode = 'P0004';
  end if;
  if v_instant > now() + interval '5 minutes' then
    raise exception 'İşlem zamanı gelecekte olamaz.' using errcode = 'P0004';
  end if;

  if char_length(v_note) > 280 then
    raise exception 'Not en fazla 280 karakter olabilir.' using errcode = 'P0004';
  end if;
  if not exists (select 1 from public.gold_products where id = v_product) then
    raise exception 'Bilinmeyen altın ürünü: %', v_product using errcode = 'P0004';
  end if;

  pid := public.lock_user_portfolio(p_user_id);
  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || v_product)::bigint);

  -- Idempotency: aynı anahtar + aynı içerik -> mevcut sonuç (sürüm ARTMAZ); farklı içerik -> conflict.
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

  -- MARKET_BASELINE: sunucunun verdiği fiyat anlık görüntüsü DOĞRULANIR ve aynı işlemde saklanır.
  if v_origin = 'MARKET_BASELINE' then
    if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object' then
      raise exception 'Başlangıç fiyatı anlık görüntüsü eksik.' using errcode = 'P0004';
    end if;
    if v_snapshot ? 'product_id' and v_snapshot->>'product_id' is distinct from v_product then
      raise exception 'Fiyat anlık görüntüsü başka bir ürüne ait; takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
    end if;
    if coalesce(v_snapshot->>'provider_status', '') <> 'ok' then
      raise exception 'Fiyat verisi kullanılamıyor; takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
    end if;
    if btrim(coalesce(v_snapshot->>'provider', '')) = '' or btrim(coalesce(v_snapshot->>'market', '')) = '' then
      raise exception 'Fiyat sağlayıcısı veya piyasası belirsiz.' using errcode = 'P0004';
    end if;
    if coalesce(v_snapshot->>'currency', 'TRY') <> 'TRY' then
      raise exception 'Fiyat para birimi TL olmalıdır.' using errcode = 'P0004';
    end if;
    begin
      v_liq := (v_snapshot->>'liquidation_price')::numeric;
      v_rep := (v_snapshot->>'replacement_price')::numeric;
      v_provider_ts := (v_snapshot->>'provider_timestamp')::timestamptz;
      v_fetched_at := (v_snapshot->>'fetched_at')::timestamptz;
      v_stale_ms := nullif(v_snapshot->>'stale_after_ms', '')::numeric;
    exception when others then
      raise exception 'Fiyat anlık görüntüsü geçersiz.' using errcode = 'P0004';
    end;
    if v_liq is null or v_liq <= 0 or v_rep is null or v_rep <= 0 then
      raise exception 'Başlangıç fiyatı geçersiz.' using errcode = 'P0004';
    end if;
    if v_rep < v_liq then
      raise exception 'Fiyat makası tutarsız: yeniden alım fiyatı bozdurma fiyatından düşük olamaz.' using errcode = 'P0004';
    end if;
    if v_provider_ts is null or v_fetched_at is null then
      raise exception 'Fiyat zamanı geçersiz.' using errcode = 'P0004';
    end if;
    if v_provider_ts > now() + interval '5 minutes' or v_fetched_at > now() + interval '5 minutes' then
      raise exception 'Fiyat zamanı gelecekte; anlık görüntü reddedildi.' using errcode = 'P0004';
    end if;
    -- Etkin tazelik sınırı: 15 dk ile sağlayıcının stale_after_ms değerinin küçüğü (TypeScript ile aynı).
    v_max_age := interval '15 minutes';
    if v_stale_ms is not null and v_stale_ms > 0 and (v_stale_ms / 1000.0) * interval '1 second' < v_max_age then
      v_max_age := (v_stale_ms / 1000.0) * interval '1 second';
    end if;
    if v_fetched_at < now() - v_max_age then
      raise exception 'Fiyat verisi bayat; takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
    end if;
    if v_provider_ts < now() - v_max_age then
      raise exception 'Sağlayıcı fiyat zamanı eski; veri yeni çekilmiş görünse bile takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
    end if;
    if v_fetched_at < v_provider_ts - interval '5 minutes' then
      raise exception 'Fiyat, sağlayıcı zamanından önce çekilmiş görünüyor; veri tutarsız.' using errcode = 'P0004';
    end if;

    insert into public.price_snapshots
      (user_id, product_id, liquidation_price, replacement_price, provider, market, currency,
       provider_status, is_real_market_data, provider_timestamp, fetched_at)
    values
      (p_user_id, v_product, v_liq, v_rep,
       v_snapshot->>'provider', v_snapshot->>'market', 'TRY',
       'ok',
       coalesce((v_snapshot->>'is_real_market_data')::boolean, false),
       v_provider_ts, v_fetched_at)
    returning id, liquidation_price into v_snapshot_id, v_baseline;
  end if;

  amounts := public.ledger_compute_amounts(
    v_kind, v_mode, v_qty, v_unit_price, v_total, v_fees, v_work, v_baseline);

  insert into public.transactions
    (user_id, portfolio_id, product_id, side, transaction_kind, quantity, unit, traded_at,
     occurred_at, occurred_time,
     unit_price, fee_amount, note, pricing_input_mode,
     quoted_acquisition_unit_price, quoted_disposal_unit_price,
     gross_amount, fees, workmanship, total_paid, net_proceeds, cost_basis_origin, price_snapshot_id,
     status, created_by, client_request_id, request_hash, replaces_transaction_id)
  values
    (p_user_id, pid, v_product,
     case when v_kind = 'SELL' then 'sell' else 'buy' end,
     v_kind, v_qty, v_unit, v_occurred,
     v_instant, v_time,
     coalesce((amounts->>'quoted_acquisition_unit_price')::numeric,
              (amounts->>'quoted_disposal_unit_price')::numeric,
              case when (amounts->>'total_paid') is not null then round((amounts->>'total_paid')::numeric / v_qty, 8) end,
              case when (amounts->>'net_proceeds') is not null then round((amounts->>'net_proceeds')::numeric / v_qty, 8) end,
              0),
     (amounts->>'fees')::numeric,
     v_note, v_mode,
     (amounts->>'quoted_acquisition_unit_price')::numeric,
     (amounts->>'quoted_disposal_unit_price')::numeric,
     (amounts->>'gross')::numeric,
     (amounts->>'fees')::numeric,
     (amounts->>'workmanship')::numeric,
     (amounts->>'total_paid')::numeric,
     (amounts->>'net_proceeds')::numeric,
     v_origin, v_snapshot_id, 'ACTIVE', v_created_by, v_req, v_hash, v_replaces)
  returning * into created;

  -- Pozisyon aynı transaction içinde yeniden oluşturulur; oversell tüm işlemi geri alır.
  pos := public.ledger_rebuild_position(p_user_id, v_product);
  -- Gerçek değişiklik: sürüm sinyali aynı transaction içinde artar.
  perform public.ledger_bump_revision(p_user_id);

  return jsonb_build_object(
    'transaction', public.ledger_transaction_json(created),
    'position', pos,
    'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. ledger_void / ledger_replace / ledger_void_all: sürüm artışı ve replay biçimi
-- -----------------------------------------------------------------------------

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
  perform public.ledger_bump_revision(p_user_id);

  return jsonb_build_object(
    'transaction', public.ledger_transaction_json(updated),
    'position', pos);
end;
$$;

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
  pos_old jsonb;
  pos_new jsonb;
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
      -- Replay yanıtı ilk yanıtla AYNI biçimdedir: [eski ürün, (farklıysa) yeni ürün].
      select public.ledger_position_json(pp) into pos_old from public.portfolio_positions pp
      where pp.user_id = p_user_id and pp.product_id = target.product_id;
      positions := jsonb_build_array(coalesce(pos_old, public.ledger_empty_position_json(target.product_id)));
      if existing.product_id <> target.product_id then
        select public.ledger_position_json(pp) into pos_new from public.portfolio_positions pp
        where pp.user_id = p_user_id and pp.product_id = existing.product_id;
        positions := positions || jsonb_build_array(coalesce(pos_new, public.ledger_empty_position_json(existing.product_id)));
      end if;
      return jsonb_build_object(
        'voided', public.ledger_transaction_json(voided),
        'transaction', appended->'transaction',
        'positions', positions,
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

  -- ledger_append sürümü bir kez artırır; ek artış yapılmaz (sinyal, sayaç değil).
  appended := public.ledger_append(p_user_id, v_payload);
  created_id := (appended->'transaction'->>'id')::uuid;

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

  -- Gerçekten kayıt iptal edildiyse sürüm artar; boş çağrı sinyal üretmez.
  if affected > 0 then
    perform public.ledger_bump_revision(p_user_id);
  end if;

  return affected;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Yetkiler
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
    'public.ledger_verify(uuid)',
    'public.ledger_revision(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;

  foreach fn in array array[
    'public.ledger_compute_amounts(text, text, numeric, numeric, numeric, numeric, numeric, numeric)',
    'public.ledger_parse_numeric(text, text)',
    'public.ledger_parse_uuid(text, text)',
    'public.ledger_bump_revision(uuid)',
    'public.guard_portfolio_revision()',
    'public.ledger_replay_product(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
end;
$$;
