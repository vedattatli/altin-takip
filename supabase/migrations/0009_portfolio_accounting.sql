-- =============================================================================
-- Altın Takip — 0009 Portföy muhasebe şeması
--
-- ÜRÜN BAZLI HAREKETLİ AĞIRLIKLI ORTALAMA MALİYET
--
-- Kaynak gerçek: append-only işlem defteri (public.transactions genişletilir).
--   - Kayıtlar değiştirilmez; yalnızca durumu ACTIVE -> VOID / REPLACED olur.
--   - Hard delete yoktur (hesap silme cascade'i hariç).
--   - Deterministik sıra: traded_at (occurred_at), created_at, ledger_sequence.
--   - Idempotency: (user_id, client_request_id) benzersiz; request_hash ile içerik karşılaştırılır.
-- Türetilmiş projeksiyon: public.portfolio_positions (yalnızca RPC'ler yazar).
-- Değiştirilemez fiyat anlık görüntüsü: public.price_snapshots (MARKET_BASELINE için).
--
-- Bütün para/miktar sütunları numeric'tir; JSON'a metin olarak çıkarılır (0010).
-- Eski migration'lar değiştirilmez; bu dosya tekrar çalıştırılabilir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. price_snapshots — açılış bakiyesi için değiştirilemez fiyat kaydı
-- -----------------------------------------------------------------------------

create table if not exists public.price_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  product_id text not null references public.gold_products (id),
  -- Kuyumcunun kullanıcıdan aldığı fiyat (bozdurma) — başlangıç maliyet bazı buna dayanır.
  liquidation_price numeric(20, 8) not null,
  -- Kuyumcunun kullanıcıya sattığı fiyat (yeniden alım).
  replacement_price numeric(20, 8) not null,
  provider text not null,
  market text not null,
  currency text not null default 'TRY',
  provider_status text not null,
  is_real_market_data boolean not null default false,
  provider_timestamp timestamptz not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint price_snapshots_liquidation_positive check (liquidation_price > 0),
  constraint price_snapshots_replacement_positive check (replacement_price > 0)
);

create index if not exists price_snapshots_user_product_idx
  on public.price_snapshots (user_id, product_id);

alter table public.price_snapshots enable row level security;
alter table public.price_snapshots force row level security;

drop policy if exists price_snapshots_select_own on public.price_snapshots;
create policy price_snapshots_select_own on public.price_snapshots
  for select to authenticated
  using (user_id = auth.uid());

revoke all on table public.price_snapshots from public;
revoke all on table public.price_snapshots from anon;
revoke all on table public.price_snapshots from authenticated;
revoke all on table public.price_snapshots from service_role;
grant select on table public.price_snapshots to authenticated;
grant select, insert on table public.price_snapshots to service_role;

/** Anlık görüntü değiştirilemez ve silinemez (hesap silme cascade'i hariç). */
create or replace function public.reject_snapshot_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- Profil cascade ile siliniyorsa satır zaten yok; o zaman izin verilir.
    if exists (select 1 from public.profiles where id = old.user_id) then
      raise exception 'Fiyat anlık görüntüsü silinemez.' using errcode = '42501';
    end if;
    return old;
  end if;
  raise exception 'Fiyat anlık görüntüsü değiştirilemez.' using errcode = '42501';
end;
$$;

drop trigger if exists price_snapshots_no_update on public.price_snapshots;
create trigger price_snapshots_no_update
  before update on public.price_snapshots
  for each row execute function public.reject_snapshot_mutation();

drop trigger if exists price_snapshots_no_delete on public.price_snapshots;
create trigger price_snapshots_no_delete
  before delete on public.price_snapshots
  for each row execute function public.reject_snapshot_mutation();

-- -----------------------------------------------------------------------------
-- 2. transactions — işlem defteri sütunları
-- -----------------------------------------------------------------------------

alter table public.transactions
  add column if not exists transaction_kind text not null default 'BUY',
  add column if not exists pricing_input_mode text not null default 'UNIT_PRICE',
  add column if not exists acquisition_unit_price numeric(20, 8),
  add column if not exists disposal_unit_price numeric(20, 8),
  add column if not exists gross_amount numeric(20, 8) not null default 0,
  add column if not exists fees numeric(20, 8) not null default 0,
  add column if not exists workmanship numeric(20, 8) not null default 0,
  add column if not exists total_paid numeric(20, 8),
  add column if not exists net_proceeds numeric(20, 8),
  add column if not exists cost_basis_origin text not null default 'ACTUAL',
  add column if not exists price_snapshot_id uuid references public.price_snapshots (id),
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists replaces_transaction_id uuid references public.transactions (id),
  add column if not exists replaced_by_transaction_id uuid references public.transactions (id),
  add column if not exists created_by uuid,
  add column if not exists client_request_id text,
  add column if not exists request_hash text,
  add column if not exists ledger_sequence bigint generated by default as identity;

comment on column public.transactions.traded_at is
  'İşlemin gerçekleştiği tarih (occurred_at). Sıralama: traded_at, created_at, ledger_sequence.';
comment on column public.transactions.transaction_kind is 'OPENING_BALANCE | BUY | SELL';
comment on column public.transactions.pricing_input_mode is 'UNIT_PRICE | TOTAL_AMOUNT | MARKET_BASELINE';
comment on column public.transactions.acquisition_unit_price is
  'Alışta kullanıcının gerçekten ödediği birim fiyat (piyasa fiyatı DEĞİL). TOTAL_AMOUNT modunda bilgi amaçlı türetilir.';
comment on column public.transactions.disposal_unit_price is
  'Satışta kullanıcının gerçekten aldığı birim fiyat (piyasa fiyatı DEĞİL).';
comment on column public.transactions.total_paid is 'BUY/OPENING_BALANCE: masraflar dâhil toplam edinim maliyeti.';
comment on column public.transactions.net_proceeds is 'SELL: masraflar düşülmüş net tahsilat.';
comment on column public.transactions.cost_basis_origin is 'ACTUAL | ESTIMATED | MARKET_BASELINE';
comment on column public.transactions.status is 'ACTIVE | VOID | REPLACED — hard delete yoktur.';
comment on column public.transactions.unit_price is
  'Eski sütun; acquisition_unit_price / disposal_unit_price ile aynı değeri taşır (uyumluluk).';
comment on column public.transactions.fee_amount is 'Eski sütun; fees ile aynı değeri taşır (uyumluluk).';
comment on column public.transactions.side is 'Eski sütun; SELL için sell, diğer türler için buy (uyumluluk).';

-- Eski kayıtlar: ACTUAL / UNIT_PRICE olarak deftere taşınır (idempotent).
update public.transactions
set transaction_kind = 'SELL'
where side = 'sell' and transaction_kind = 'BUY';

update public.transactions
set acquisition_unit_price = case when transaction_kind <> 'SELL' then unit_price else null end,
    disposal_unit_price = case when transaction_kind = 'SELL' then unit_price else null end,
    gross_amount = quantity * unit_price,
    fees = fee_amount,
    workmanship = 0,
    total_paid = case when transaction_kind <> 'SELL' then quantity * unit_price + fee_amount else null end,
    net_proceeds = case when transaction_kind = 'SELL' then quantity * unit_price - fee_amount else null end
where total_paid is null and net_proceeds is null;

-- Birim fiyat artık sıfır olabilir (net tahsilat 0 olan satışın türetilmiş fiyatı).
alter table public.transactions drop constraint if exists transactions_unit_price_positive;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_unit_price_non_negative') then
    alter table public.transactions
      add constraint transactions_unit_price_non_negative check (unit_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_kind_check') then
    alter table public.transactions
      add constraint transactions_kind_check
      check (transaction_kind in ('OPENING_BALANCE', 'BUY', 'SELL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_pricing_mode_check') then
    alter table public.transactions
      add constraint transactions_pricing_mode_check
      check (pricing_input_mode in ('UNIT_PRICE', 'TOTAL_AMOUNT', 'MARKET_BASELINE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_origin_check') then
    alter table public.transactions
      add constraint transactions_origin_check
      check (cost_basis_origin in ('ACTUAL', 'ESTIMATED', 'MARKET_BASELINE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_status_check') then
    alter table public.transactions
      add constraint transactions_status_check check (status in ('ACTIVE', 'VOID', 'REPLACED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_amounts_non_negative') then
    alter table public.transactions
      add constraint transactions_amounts_non_negative
      check (gross_amount >= 0 and fees >= 0 and workmanship >= 0
             and coalesce(total_paid, 0) >= 0 and coalesce(net_proceeds, 0) >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_side_kind_consistent') then
    alter table public.transactions
      add constraint transactions_side_kind_consistent
      check ((transaction_kind = 'SELL') = (side = 'sell'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_baseline_requires_snapshot') then
    alter table public.transactions
      add constraint transactions_baseline_requires_snapshot
      check (cost_basis_origin <> 'MARKET_BASELINE' or price_snapshot_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_void_fields') then
    alter table public.transactions
      add constraint transactions_void_fields
      check (status = 'ACTIVE' or voided_at is not null);
  end if;
end;
$$;

-- Idempotency: aynı kullanıcı + istek kimliği yalnızca bir kez.
create unique index if not exists transactions_client_request_idx
  on public.transactions (user_id, client_request_id)
  where client_request_id is not null;

create index if not exists transactions_ledger_order_idx
  on public.transactions (user_id, product_id, status, traded_at, created_at, ledger_sequence);

/**
 * Defter koruması: kayıt yalnızca ACTIVE -> VOID / REPLACED geçişiyle değişir;
 * finansal alanlar değiştirilemez; hard delete yalnızca hesap cascade'inde mümkündür.
 */
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

  -- Değiştirilemez alanlar
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.portfolio_id is distinct from old.portfolio_id
     or new.product_id is distinct from old.product_id
     or new.transaction_kind is distinct from old.transaction_kind
     or new.side is distinct from old.side
     or new.quantity is distinct from old.quantity
     or new.unit is distinct from old.unit
     or new.traded_at is distinct from old.traded_at
     or new.pricing_input_mode is distinct from old.pricing_input_mode
     or new.acquisition_unit_price is distinct from old.acquisition_unit_price
     or new.disposal_unit_price is distinct from old.disposal_unit_price
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
    -- "Neyle düzeltildiği" REPLACED kayda yalnızca BİR KEZ (boşken) yazılabilir.
    if new.replaced_by_transaction_id is distinct from old.replaced_by_transaction_id
       and not (old.replaced_by_transaction_id is null and new.status = 'REPLACED') then
      raise exception 'İptal edilmiş kayıt yeniden düzenlenemez.' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists transactions_ledger_guard_update on public.transactions;
create trigger transactions_ledger_guard_update
  before update on public.transactions
  for each row execute function public.guard_ledger_mutation();

drop trigger if exists transactions_ledger_guard_delete on public.transactions;
create trigger transactions_ledger_guard_delete
  before delete on public.transactions
  for each row execute function public.guard_ledger_mutation();

-- -----------------------------------------------------------------------------
-- 3. portfolio_positions — türetilmiş projeksiyon (elle düzenlenmez)
-- -----------------------------------------------------------------------------

create table if not exists public.portfolio_positions (
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  product_id text not null references public.gold_products (id),
  quantity numeric(20, 6) not null default 0,
  remaining_cost_basis numeric(20, 8) not null default 0,
  -- Miktar sıfırsa null (belgelenmiş tek davranış).
  average_cost numeric(20, 8),
  realized_pnl numeric(20, 8) not null default 0,
  has_actual boolean not null default false,
  has_estimated boolean not null default false,
  has_baseline boolean not null default false,
  active_transaction_count integer not null default 0,
  last_ledger_sequence bigint not null default 0,
  updated_at timestamptz not null default now(),

  primary key (portfolio_id, product_id),
  constraint portfolio_positions_quantity_non_negative check (quantity >= 0),
  constraint portfolio_positions_cost_non_negative check (remaining_cost_basis >= 0),
  constraint portfolio_positions_zero_quantity_zero_cost
    check (quantity > 0 or (remaining_cost_basis = 0 and average_cost is null))
);

create index if not exists portfolio_positions_user_idx on public.portfolio_positions (user_id);

alter table public.portfolio_positions enable row level security;
alter table public.portfolio_positions force row level security;

drop policy if exists portfolio_positions_select_own on public.portfolio_positions;
create policy portfolio_positions_select_own on public.portfolio_positions
  for select to authenticated
  using (user_id = auth.uid());

-- Projeksiyonu YALNIZCA SECURITY DEFINER RPC'ler (sahip yetkisiyle) yazar;
-- service_role bile doğrudan düzenleyemez.
revoke all on table public.portfolio_positions from public;
revoke all on table public.portfolio_positions from anon;
revoke all on table public.portfolio_positions from authenticated;
revoke all on table public.portfolio_positions from service_role;
grant select on table public.portfolio_positions to authenticated;
grant select on table public.portfolio_positions to service_role;

comment on table public.portfolio_positions is
  'Defterden türetilen pozisyon projeksiyonu. Kaynak gerçek değildir; ledger_rebuild_position ile yeniden oluşturulur.';

-- Yeni fonksiyonun yetkileri (tetikleyici; hiçbir role açık değil)
revoke all on function public.reject_snapshot_mutation() from public;
revoke all on function public.reject_snapshot_mutation() from anon;
revoke all on function public.reject_snapshot_mutation() from authenticated;
revoke all on function public.reject_snapshot_mutation() from service_role;
revoke all on function public.guard_ledger_mutation() from public;
revoke all on function public.guard_ledger_mutation() from anon;
revoke all on function public.guard_ledger_mutation() from authenticated;
revoke all on function public.guard_ledger_mutation() from service_role;
