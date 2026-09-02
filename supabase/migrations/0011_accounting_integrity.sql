-- =============================================================================
-- Altın Takip — 0011 Muhasebe bütünlüğü ve veri semantiği (Sprint 1.1)
--
-- 1. FİNANSAL YAZMA SINIRI VERİTABANINDA ZORUNLU: service_role artık
--    public.transactions ve public.price_snapshots tablolarına DOĞRUDAN yazamaz;
--    yalnızca SECURITY DEFINER defter RPC'leri (ledger_append / ledger_void /
--    ledger_replace / ledger_void_all) sahip yetkisiyle yazar. portfolio_positions
--    zaten kapalıydı.
-- 2. MALİYET KÖKENİ AYRIMI: has_* bayrakları "elde kalan miktarın kökeni"dir ve
--    miktar sıfıra inince sıfırlanır; realized_has_* bayrakları gerçekleşmiş K/Z'nin
--    tarihsel kökenini korur (tam satıştan sonra silinmez).
-- 3. GİRİLEN FİYAT ≠ EFEKTİF MALİYET: acquisition_unit_price → quoted_acquisition_unit_price
--    (kullanıcının girdiği birim fiyat, masraf hariç; TOTAL_AMOUNT'ta null),
--    disposal_unit_price → quoted_disposal_unit_price; efektif değerler türetilmiş
--    sütunlardır: effective_acquisition_unit_cost = total_paid/quantity,
--    effective_net_unit_proceeds = net_proceeds/quantity.
-- 4. İŞLEM ZAMANI: occurred_at timestamptz (tarih + isteğe bağlı saat, Europe/Istanbul)
--    ve occurred_time. Deterministik sıra: occurred_at, created_at, ledger_sequence, id.
--    Takvimde olmayan tarih ve gelecek zaman RPC'de açık hatayla (P0004) reddedilir.
-- 5. FİYAT ANLIK GÖRÜNTÜSÜ DOĞRULAMASI: makas (replacement >= liquidation), para birimi,
--    sağlayıcı/piyasa, zaman (geçersiz / gelecek / bayat) hem kısıt hem RPC düzeyinde.
--
-- Eski migration'lar değiştirilmez; bu dosya tekrar çalıştırılabilir (idempotent).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Yetkiler: doğrudan yazma yolu kapatılır
-- -----------------------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on table public.transactions from service_role;
grant select on table public.transactions to service_role;

revoke insert, update, delete, truncate, references, trigger on table public.price_snapshots from service_role;
grant select on table public.price_snapshots to service_role;

-- Savunma amaçlı tekrar (0009 ile aynı): projeksiyon hiçbir role yazılabilir değildir.
revoke insert, update, delete, truncate, references, trigger on table public.portfolio_positions from service_role;
grant select on table public.portfolio_positions to service_role;

comment on table public.transactions is
  'Append-only işlem defteri (kaynak gerçek). Yazma yalnızca ledger_append / ledger_void / ledger_replace RPC''leri ile; service_role dâhil hiçbir rolün doğrudan INSERT/UPDATE/DELETE yetkisi yoktur.';

-- -----------------------------------------------------------------------------
-- 2. transactions: sütunlar (quoted/effective, occurred_at, occurred_time)
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions' and column_name = 'acquisition_unit_price')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions' and column_name = 'quoted_acquisition_unit_price') then
    alter table public.transactions rename column acquisition_unit_price to quoted_acquisition_unit_price;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions' and column_name = 'disposal_unit_price')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions' and column_name = 'quoted_disposal_unit_price') then
    alter table public.transactions rename column disposal_unit_price to quoted_disposal_unit_price;
  end if;
end;
$$;

alter table public.transactions
  add column if not exists effective_acquisition_unit_cost numeric(20, 8)
    generated always as (
      case when total_paid is not null and quantity > 0 then round(total_paid / quantity, 8) end
    ) stored,
  add column if not exists effective_net_unit_proceeds numeric(20, 8)
    generated always as (
      case when net_proceeds is not null and quantity > 0 then round(net_proceeds / quantity, 8) end
    ) stored,
  add column if not exists occurred_at timestamptz,
  add column if not exists occurred_time time(0);

comment on column public.transactions.quoted_acquisition_unit_price is
  'Kullanıcının UNIT_PRICE modunda GİRDİĞİ birim alış fiyatı (masraf HARİÇ). TOTAL_AMOUNT modunda null (uydurulmaz). MARKET_BASELINE''da anlık görüntünün bozdurma fiyatı.';
comment on column public.transactions.effective_acquisition_unit_cost is
  'total_paid / quantity — işçilik ve masraflar DÂHİL efektif birim maliyet (türetilmiş, bilgi amaçlı).';
comment on column public.transactions.quoted_disposal_unit_price is
  'Kullanıcının UNIT_PRICE modunda girdiği BRÜT birim satış fiyatı. TOTAL_AMOUNT modunda null.';
comment on column public.transactions.effective_net_unit_proceeds is
  'net_proceeds / quantity — masraflar düşülmüş net birim tahsilat (türetilmiş).';
comment on column public.transactions.occurred_at is
  'İşlem anı (timestamptz). traded_at + occurred_time (yoksa 00:00) Europe/Istanbul. Sıralama: occurred_at, created_at, ledger_sequence, id.';
comment on column public.transactions.occurred_time is
  'Kullanıcının girdiği isteğe bağlı saat (Europe/Istanbul). Girilmediyse null; sıralamada 00:00 sayılır.';
comment on column public.transactions.traded_at is
  'İşlem tarihi (Europe/Istanbul takvim günü) = (occurred_at at time zone ''Europe/Istanbul'')::date.';
comment on column public.transactions.unit_price is
  'Eski sütun; girilen (quoted) fiyat, yoksa efektif birim değerle aynı değeri taşır (uyumluluk).';

-- -----------------------------------------------------------------------------
-- 3. Defter koruması (yeni sütunlar dâhil) — backfill'den ÖNCE tanımlanır
-- -----------------------------------------------------------------------------

create or replace function public.guard_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.profiles where id = old.user_id) then
      raise exception 'Defter kaydı silinemez; iptal (VOID) kullanın.' using errcode = '42501';
    end if;
    return old;
  end if;

  -- Değiştirilemez alanlar (türetilmiş sütunlar bunlardan hesaplanır)
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.portfolio_id is distinct from old.portfolio_id
     or new.product_id is distinct from old.product_id
     or new.transaction_kind is distinct from old.transaction_kind
     or new.side is distinct from old.side
     or new.quantity is distinct from old.quantity
     or new.unit is distinct from old.unit
     or new.traded_at is distinct from old.traded_at
     or new.occurred_at is distinct from old.occurred_at
     or new.occurred_time is distinct from old.occurred_time
     or new.pricing_input_mode is distinct from old.pricing_input_mode
     or new.quoted_acquisition_unit_price is distinct from old.quoted_acquisition_unit_price
     or new.quoted_disposal_unit_price is distinct from old.quoted_disposal_unit_price
     or new.unit_price is distinct from old.unit_price
     or new.gross_amount is distinct from old.gross_amount
     or new.fees is distinct from old.fees
     or new.fee_amount is distinct from old.fee_amount
     or new.workmanship is distinct from old.workmanship
     or new.total_paid is distinct from old.total_paid
     or new.net_proceeds is distinct from old.net_proceeds
     or new.cost_basis_origin is distinct from old.cost_basis_origin
     or new.price_snapshot_id is distinct from old.price_snapshot_id
     or new.note is distinct from old.note
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by
     or new.client_request_id is distinct from old.client_request_id
     or new.request_hash is distinct from old.request_hash
     or new.replaces_transaction_id is distinct from old.replaces_transaction_id
     or new.ledger_sequence is distinct from old.ledger_sequence then
    raise exception 'Defter kaydının finansal alanları değiştirilemez; düzeltme için yeni kayıt oluşturun.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if old.status <> 'ACTIVE' or new.status not in ('VOID', 'REPLACED') then
      raise exception 'Yalnızca aktif kayıt iptal edilebilir veya düzeltilebilir.' using errcode = '42501';
    end if;
    if new.voided_at is null then
      raise exception 'İptal tarihi zorunludur.' using errcode = '42501';
    end if;
  elsif new.status <> 'ACTIVE' then
    if new.voided_at is distinct from old.voided_at
       or new.void_reason is distinct from old.void_reason then
      raise exception 'İptal edilmiş kayıt yeniden düzenlenemez.' using errcode = '42501';
    end if;
    if new.replaced_by_transaction_id is distinct from old.replaced_by_transaction_id
       and not (old.replaced_by_transaction_id is null and new.status = 'REPLACED') then
      raise exception 'İptal edilmiş kayıt yeniden düzenlenemez.' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Backfill (yalnızca ilk çalıştırmada; occurred_at boş olan satırlar)
--    Guard tetikleyicisi geçici olarak kapatılır: bu bir düzeltme değil, şema taşımasıdır.
-- -----------------------------------------------------------------------------

alter table public.transactions disable trigger transactions_ledger_guard_update;

update public.transactions t
set quoted_acquisition_unit_price = case
      when t.transaction_kind = 'SELL' then null
      when t.pricing_input_mode = 'UNIT_PRICE' and t.quantity > 0 then round(t.gross_amount / t.quantity, 8)
      when t.pricing_input_mode = 'MARKET_BASELINE' then
        (select s.liquidation_price from public.price_snapshots s where s.id = t.price_snapshot_id)
      else null
    end,
    quoted_disposal_unit_price = case
      when t.transaction_kind = 'SELL' and t.pricing_input_mode = 'UNIT_PRICE' and t.quantity > 0
        then round(t.gross_amount / t.quantity, 8)
      else null
    end,
    occurred_at = (t.traded_at::timestamp) at time zone 'Europe/Istanbul',
    occurred_time = null
where t.occurred_at is null;

alter table public.transactions enable trigger transactions_ledger_guard_update;

alter table public.transactions alter column occurred_at set not null;

do $$
begin
  if exists (select 1 from public.transactions
             where traded_at <> (occurred_at at time zone 'Europe/Istanbul')::date) then
    raise exception 'ALTIN_MIGRATION_0011: traded_at ile occurred_at tutarsız satırlar var; migration durduruldu.';
  end if;
  if exists (select 1 from public.transactions
             where occurred_time is not null
               and occurred_time <> (occurred_at at time zone 'Europe/Istanbul')::time(0)) then
    raise exception 'ALTIN_MIGRATION_0011: occurred_time ile occurred_at tutarsız satırlar var; migration durduruldu.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_occurred_date_consistent') then
    alter table public.transactions
      add constraint transactions_occurred_date_consistent
      check (traded_at = (occurred_at at time zone 'Europe/Istanbul')::date);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_occurred_time_consistent') then
    alter table public.transactions
      add constraint transactions_occurred_time_consistent
      check (occurred_time is null or occurred_time = (occurred_at at time zone 'Europe/Istanbul')::time(0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_quoted_prices_kind') then
    alter table public.transactions
      add constraint transactions_quoted_prices_kind
      check (
        coalesce(quoted_acquisition_unit_price, 0) >= 0
        and coalesce(quoted_disposal_unit_price, 0) >= 0
        and (transaction_kind <> 'SELL' or quoted_acquisition_unit_price is null)
        and (transaction_kind = 'SELL' or quoted_disposal_unit_price is null)
        and (pricing_input_mode <> 'TOTAL_AMOUNT'
             or (quoted_acquisition_unit_price is null and quoted_disposal_unit_price is null))
      );
  end if;
end;
$$;

drop index if exists public.transactions_ledger_order_idx;
create index if not exists transactions_ledger_instant_idx
  on public.transactions (user_id, product_id, status, occurred_at, created_at, ledger_sequence);

-- -----------------------------------------------------------------------------
-- 5. price_snapshots: tutarlılık kısıtları (önce mevcut veri denetlenir)
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.price_snapshots where replacement_price < liquidation_price) then
    raise exception 'ALTIN_MIGRATION_0011: price_snapshots içinde replacement_price < liquidation_price satırı var; migration durduruldu.';
  end if;
  if exists (select 1 from public.price_snapshots
             where currency <> 'TRY' or btrim(provider) = '' or btrim(market) = '') then
    raise exception 'ALTIN_MIGRATION_0011: price_snapshots içinde para birimi/sağlayıcı/piyasa geçersiz satır var; migration durduruldu.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_snapshots_spread_consistent') then
    alter table public.price_snapshots
      add constraint price_snapshots_spread_consistent check (replacement_price >= liquidation_price);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_snapshots_currency_try') then
    alter table public.price_snapshots
      add constraint price_snapshots_currency_try check (currency = 'TRY');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_snapshots_provider_market_nonempty') then
    alter table public.price_snapshots
      add constraint price_snapshots_provider_market_nonempty
      check (btrim(provider) <> '' and btrim(market) <> '');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. portfolio_positions: gerçekleşmiş K/Z köken bayrakları
-- -----------------------------------------------------------------------------

alter table public.portfolio_positions
  add column if not exists realized_has_actual boolean not null default false,
  add column if not exists realized_has_estimated boolean not null default false,
  add column if not exists realized_has_baseline boolean not null default false;

comment on column public.portfolio_positions.has_actual is
  'ELDE KALAN miktarın kökeni (holdingCostOrigins). Miktar sıfıra inince sıfırlanır.';
comment on column public.portfolio_positions.has_estimated is
  'ELDE KALAN miktarın kökeni (holdingCostOrigins). Miktar sıfıra inince sıfırlanır.';
comment on column public.portfolio_positions.has_baseline is
  'ELDE KALAN miktarın kökeni (holdingCostOrigins). Miktar sıfıra inince sıfırlanır.';
comment on column public.portfolio_positions.realized_has_actual is
  'Gerçekleşmiş K/Z''nin tarihsel kökeni (realizedPnlOrigins). Tam satıştan sonra silinmez.';
comment on column public.portfolio_positions.realized_has_estimated is
  'Gerçekleşmiş K/Z''nin tarihsel kökeni (realizedPnlOrigins). Tam satıştan sonra silinmez.';
comment on column public.portfolio_positions.realized_has_baseline is
  'Gerçekleşmiş K/Z''nin tarihsel kökeni (realizedPnlOrigins). Tam satıştan sonra silinmez.';

-- -----------------------------------------------------------------------------
-- 7. JSON yardımcıları (yeni alanlar)
-- -----------------------------------------------------------------------------

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
    'occurredTime', case when t.occurred_time is null then null else to_char(t.occurred_time, 'HH24:MI') end,
    'occurredAtInstant', to_char(t.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'pricingInputMode', t.pricing_input_mode,
    'quotedAcquisitionUnitPrice', public.ledger_num_text(t.quoted_acquisition_unit_price),
    'effectiveAcquisitionUnitCost', public.ledger_num_text(t.effective_acquisition_unit_cost),
    'quotedDisposalUnitPrice', public.ledger_num_text(t.quoted_disposal_unit_price),
    'effectiveNetUnitProceeds', public.ledger_num_text(t.effective_net_unit_proceeds),
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
    'holdingCostOrigins', jsonb_build_object(
      'actual', p.has_actual, 'estimated', p.has_estimated, 'baseline', p.has_baseline),
    'realizedPnlOrigins', jsonb_build_object(
      'actual', p.realized_has_actual, 'estimated', p.realized_has_estimated, 'baseline', p.realized_has_baseline),
    'activeTransactionCount', p.active_transaction_count,
    'lastLedgerSequence', p.last_ledger_sequence
  );
$$;

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
    'holdingCostOrigins', jsonb_build_object('actual', false, 'estimated', false, 'baseline', false),
    'realizedPnlOrigins', jsonb_build_object('actual', false, 'estimated', false, 'baseline', false),
    'activeTransactionCount', 0,
    'lastLedgerSequence', 0
  );
$$;

-- -----------------------------------------------------------------------------
-- 8. Tutar hesabı — girilen fiyat korunur; efektif değerler türetilmiş sütunlardadır
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
    return jsonb_build_object(
      'quoted_acquisition_unit_price', p_baseline_unit,
      'quoted_disposal_unit_price', null,
      'gross', gross, 'fees', fees, 'workmanship', work,
      'total_paid', total, 'net_proceeds', null);
  elsif p_mode = 'UNIT_PRICE' then
    if p_unit_price is null or p_unit_price <= 0 then
      raise exception 'Birim alış fiyatı sıfırdan büyük olmalıdır.' using errcode = 'P0004';
    end if;
    gross := p_quantity * p_unit_price;
    total := gross + work + fees;
    return jsonb_build_object(
      'quoted_acquisition_unit_price', p_unit_price,
      'quoted_disposal_unit_price', null,
      'gross', gross, 'fees', fees, 'workmanship', work,
      'total_paid', total, 'net_proceeds', null);
  elsif p_mode = 'TOTAL_AMOUNT' then
    if p_total_amount is null or p_total_amount <= 0 then
      raise exception 'Toplam tutar sıfırdan büyük olmalıdır.' using errcode = 'P0004';
    end if;
    total := p_total_amount;
    gross := total - work - fees;
    if gross < 0 then
      raise exception 'Masraflar toplam ödenen tutarı aşamaz.' using errcode = 'P0004';
    end if;
    -- Girilen birim fiyat yoktur; UYDURULMAZ.
    return jsonb_build_object(
      'quoted_acquisition_unit_price', null,
      'quoted_disposal_unit_price', null,
      'gross', gross, 'fees', fees, 'workmanship', work,
      'total_paid', total, 'net_proceeds', null);
  end if;

  raise exception 'Fiyat giriş yöntemi geçersiz.' using errcode = 'P0004';
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Yeniden oynatma: occurred_at sırası + iki köken kümesi
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
      -- Satılan miktarın maliyeti havuzun o andaki kökenlerine dayanır; tarihsel olarak korunur.
      real_actual := real_actual or hold_actual;
      real_estimated := real_estimated or hold_estimated;
      real_baseline := real_baseline or hold_baseline;
      running_qty := running_qty - r.quantity;
      running_cost := running_cost - removed;
      if running_qty = 0 then
        running_cost := 0;
        -- Pozisyon tamamen kapandı: elde kalan miktarın kökeni yok.
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
     has_actual, has_estimated, has_baseline,
     realized_has_actual, realized_has_estimated, realized_has_baseline,
     active_transaction_count, last_ledger_sequence, updated_at)
  values
    (pid, p_user_id, p_product_id,
     (replayed->>'quantity')::numeric,
     (replayed->>'remainingCostBasis')::numeric,
     (replayed->>'averageCost')::numeric,
     (replayed->>'realizedPnl')::numeric,
     (replayed->'holdingCostOrigins'->>'actual')::boolean,
     (replayed->'holdingCostOrigins'->>'estimated')::boolean,
     (replayed->'holdingCostOrigins'->>'baseline')::boolean,
     (replayed->'realizedPnlOrigins'->>'actual')::boolean,
     (replayed->'realizedPnlOrigins'->>'estimated')::boolean,
     (replayed->'realizedPnlOrigins'->>'baseline')::boolean,
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
    realized_has_actual = excluded.realized_has_actual,
    realized_has_estimated = excluded.realized_has_estimated,
    realized_has_baseline = excluded.realized_has_baseline,
    active_transaction_count = excluded.active_transaction_count,
    last_ledger_sequence = excluded.last_ledger_sequence,
    updated_at = now();

  return replayed;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. ledger_append: sıkı tarih/saat, anlık görüntü doğrulaması, yeni sütunlar
-- -----------------------------------------------------------------------------

/**
 * p_payload anahtarları: kind, product_id, quantity, unit, occurred_at (YYYY-MM-DD),
 *   occurred_time (HH:MM, isteğe bağlı), pricing_input_mode, unit_price, total_amount,
 *   fees, workmanship, cost_basis_origin, note, client_request_id, created_by,
 *   replaces_transaction_id, baseline_snapshot { product_id?, liquidation_price,
 *   replacement_price, provider, market, currency, provider_status,
 *   is_real_market_data, provider_timestamp, fetched_at }
 * Sayısal alanlar METİN olarak gelir. Zaman Europe/Istanbul yerel saatidir.
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
  v_occurred_text text := p_payload->>'occurred_at';
  v_time_text text := nullif(p_payload->>'occurred_time', '');
  v_occurred date;
  v_time time(0);
  v_instant timestamptz;
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
  v_liq numeric;
  v_rep numeric;
  v_provider_ts timestamptz;
  v_fetched_at timestamptz;
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
  -- Europe/Istanbul yerel zamanı → an. Saat girilmediyse günün başlangıcı.
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
    if v_fetched_at < now() - interval '15 minutes' then
      raise exception 'Fiyat verisi bayat; takip başlangıcı oluşturulamaz.' using errcode = 'P0004';
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

  return jsonb_build_object(
    'transaction', public.ledger_transaction_json(created),
    'position', pos,
    'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Okuma RPC'leri: yeni sıra ve köken karşılaştırması
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
              order by t.occurred_at desc, t.created_at desc, t.ledger_sequence desc, t.id desc),
    '[]'::jsonb)
  from public.transactions t
  where t.user_id = p_user_id;
$$;

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

    foreach field in array array[
      'quantity', 'remainingCostBasis', 'averageCost', 'realizedPnl',
      'holdingCostOrigins', 'realizedPnlOrigins'
    ] loop
      stored_value := case field
        when 'quantity' then public.ledger_num_text(stored.quantity)
        when 'remainingCostBasis' then public.ledger_num_text(stored.remaining_cost_basis)
        when 'averageCost' then public.ledger_num_text(stored.average_cost)
        when 'realizedPnl' then public.ledger_num_text(stored.realized_pnl)
        when 'holdingCostOrigins' then jsonb_build_object(
          'actual', stored.has_actual, 'estimated', stored.has_estimated, 'baseline', stored.has_baseline)::text
        else jsonb_build_object(
          'actual', stored.realized_has_actual, 'estimated', stored.realized_has_estimated,
          'baseline', stored.realized_has_baseline)::text end;
      replayed_value := case
        when field in ('holdingCostOrigins', 'realizedPnlOrigins') then (replayed->field)::text
        else replayed->>field end;
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
-- 12. Mevcut projeksiyonlar yeni semantikle yeniden oluşturulur
-- -----------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select distinct t.user_id, t.product_id
    from public.transactions t
    where exists (select 1 from public.portfolios p where p.user_id = t.user_id)
    union
    select pp.user_id, pp.product_id from public.portfolio_positions pp
  loop
    perform public.ledger_rebuild_position(r.user_id, r.product_id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Yetkiler — üst seviye RPC'ler yalnızca service_role; yardımcılar hiçbir role
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
    'public.ledger_rebuild_position(uuid, text)',
    'public.guard_ledger_mutation()',
    'public.reject_snapshot_mutation()'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
end;
$$;
