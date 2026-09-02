-- =============================================================================
-- Altın Takip — 0005 Güvenlik sertleştirme
--
-- Bu migration mevcut migration dosyalarını DEĞİŞTİRMEZ; üzerine ekler.
-- Var olan verilerle güvenle çalışacak biçimde yazılmıştır: kısıt eklemeden
-- önce çakışan satırlar tespit edilir ve açık bir hata ile durdurulur.
--
-- İçerik
--  1. Oturum süreleri (idle / absolute / last_seen / revoked)
--  2. Portföy ve işlem bütünlüğü (unique + composite foreign key)
--  3. Birim tutarlılığı (ürün kataloğu ile uyum)
--  4. Atomik işlem yazımı (aşırı satış eşzamanlılıkta da engellenir)
--  5. Dağıtık giriş hız sınırlayıcı
--  6. Denetim kaydının değiştirilemezliği (trigger düzeyinde)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. OTURUM SÜRELERİ
-- -----------------------------------------------------------------------------

alter table public.app_sessions
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists idle_expires_at timestamptz,
  add column if not exists absolute_expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- Mevcut satırlarda absolute_expires_at boşsa eski expires_at değerinden doldurulur.
update public.app_sessions
set absolute_expires_at = coalesce(absolute_expires_at, expires_at)
where absolute_expires_at is null;

alter table public.app_sessions
  alter column absolute_expires_at set not null;

-- Ortak cihaz oturumlarında hareketsizlik süresi zorunludur.
alter table public.app_sessions
  drop constraint if exists app_sessions_shared_needs_idle;

alter table public.app_sessions
  add constraint app_sessions_shared_needs_idle
  check (device_mode <> 'shared' or idle_expires_at is not null);

create index if not exists app_sessions_idle_expires_idx
  on public.app_sessions (idle_expires_at)
  where idle_expires_at is not null;

create index if not exists app_sessions_absolute_expires_idx
  on public.app_sessions (absolute_expires_at);

comment on column public.app_sessions.idle_expires_at is
  'Hareketsizlik son kullanma zamanı. Ortak cihazda 15 dakika, kişisel cihazda null.';
comment on column public.app_sessions.absolute_expires_at is
  'Mutlak son kullanma zamanı. Ortak cihazda 8 saat, kişisel cihazda 14 gün. Her zaman doludur.';

/**
 * Süresi geçmiş oturumları siler. Zamanlanmış görevle (pg_cron) çağrılabilir.
 */
create or replace function public.purge_expired_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.app_sessions
  where revoked_at is not null
     or absolute_expires_at <= now()
     or (idle_expires_at is not null and idle_expires_at <= now());
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_sessions() from public;

-- -----------------------------------------------------------------------------
-- 2. PORTFÖY VE İŞLEM BÜTÜNLÜĞÜ
-- -----------------------------------------------------------------------------

-- Şu an kullanıcı başına TEK portföy modeli kullanılıyor.
-- Kısıt eklemeden önce çakışma var mı bakılır.
do $$
declare
  duplicates integer;
begin
  select count(*) into duplicates
  from (
    select user_id from public.portfolios group by user_id having count(*) > 1
  ) as t;

  if duplicates > 0 then
    raise exception
      'Migration durduruldu: % kullanıcının birden fazla portföyü var. Önce veri birleştirmesi yapın.',
      duplicates;
  end if;
end;
$$;

alter table public.portfolios
  drop constraint if exists portfolios_user_id_key;

alter table public.portfolios
  add constraint portfolios_user_id_key unique (user_id);

-- Composite foreign key için gerekli benzersiz anahtar.
alter table public.portfolios
  drop constraint if exists portfolios_id_user_id_key;

alter table public.portfolios
  add constraint portfolios_id_user_id_key unique (id, user_id);

-- İşlemin portföyü ile kullanıcısı AYNI sahibe ait olmak zorundadır.
-- Önce tutarsız satır var mı bakılır.
do $$
declare
  mismatched integer;
begin
  select count(*) into mismatched
  from public.transactions t
  join public.portfolios p on p.id = t.portfolio_id
  where p.user_id <> t.user_id;

  if mismatched > 0 then
    raise exception
      'Migration durduruldu: % işlem kaydının portföyü başka kullanıcıya ait. Önce veriyi düzeltin.',
      mismatched;
  end if;
end;
$$;

alter table public.transactions
  drop constraint if exists transactions_portfolio_id_fkey;

alter table public.transactions
  drop constraint if exists transactions_portfolio_owner_fkey;

alter table public.transactions
  add constraint transactions_portfolio_owner_fkey
  foreign key (portfolio_id, user_id)
  references public.portfolios (id, user_id)
  on delete cascade;

comment on constraint transactions_portfolio_owner_fkey on public.transactions is
  'Bir işlemin portfolio_id ve user_id değerleri aynı portföy sahibine ait olmak zorundadır.';

-- -----------------------------------------------------------------------------
-- 3. BİRİM TUTARLILIĞI
-- -----------------------------------------------------------------------------

/**
 * İşlemdeki birim, ürün kataloğundaki birimle aynı olmalıdır.
 * (Ör. "Yeni Çeyrek" adet ile takip edilir; gram kaydı reddedilir.)
 */
create or replace function public.enforce_transaction_unit()
returns trigger
language plpgsql
as $$
declare
  catalog_unit text;
begin
  select unit into catalog_unit
  from public.gold_products
  where id = new.product_id;

  if catalog_unit is null then
    raise exception 'Bilinmeyen altın ürünü: %', new.product_id using errcode = '23514';
  end if;

  if new.unit is distinct from catalog_unit then
    raise exception 'Ürün birimi uyuşmuyor: % için birim % olmalıdır.', new.product_id, catalog_unit
      using errcode = '23514';
  end if;

  -- Adet ile takip edilen üründe miktar tam sayı olmalıdır.
  if catalog_unit = 'adet' and new.quantity <> trunc(new.quantity) then
    raise exception 'Adet ile takip edilen üründe miktar tam sayı olmalıdır.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists transactions_enforce_unit on public.transactions;
create trigger transactions_enforce_unit
  before insert or update on public.transactions
  for each row execute function public.enforce_transaction_unit();

-- -----------------------------------------------------------------------------
-- 4. ATOMİK İŞLEM YAZIMI (AŞIRI SATIŞ KORUMASI)
-- -----------------------------------------------------------------------------

/**
 * Bir ürünün kronolojik hiçbir anında eldeki miktarın negatife düşmediğini
 * doğrular. Düşerse ALTIN_OVERSELL işaretli hata fırlatır.
 *
 * Çağıran fonksiyonlar kullanıcının portföy satırını FOR UPDATE ile kilitler;
 * böylece iki eşzamanlı satış birlikte eldeki miktarı aşamaz.
 */
create or replace function public.assert_no_oversell(p_user_id uuid, p_product_id text)
returns void
language plpgsql
as $$
declare
  running numeric := 0;
  row_record record;
begin
  for row_record in
    select side, quantity
    from public.transactions
    where user_id = p_user_id and product_id = p_product_id
    order by traded_at, created_at, id
  loop
    if row_record.side = 'buy' then
      running := running + row_record.quantity;
    else
      running := running - row_record.quantity;
    end if;

    if running < -0.000001 then
      raise exception 'ALTIN_OVERSELL: % ürününde satış eldeki miktarı aşıyor.', p_product_id
        using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

/** Kullanıcının portföyünü kilitler; yoksa oluşturur. */
create or replace function public.lock_user_portfolio(p_user_id uuid)
returns uuid
language plpgsql
as $$
declare
  portfolio_id uuid;
begin
  select id into portfolio_id
  from public.portfolios
  where user_id = p_user_id
  for update;

  if portfolio_id is null then
    insert into public.portfolios (user_id, name)
    values (p_user_id, 'Portföyüm')
    returning id into portfolio_id;

    -- Yeni eklenen satır da kilitlenir.
    perform 1 from public.portfolios where id = portfolio_id for update;
  end if;

  return portfolio_id;
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
  portfolio_id uuid;
  created public.transactions;
begin
  portfolio_id := public.lock_user_portfolio(p_user_id);

  insert into public.transactions
    (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price, fee_amount, note)
  values
    (p_user_id, portfolio_id, p_product_id, p_side, p_quantity, p_unit, p_traded_at,
     p_unit_price, p_fee_amount, coalesce(p_note, ''))
  returning * into created;

  perform public.assert_no_oversell(p_user_id, p_product_id);
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
  updated public.transactions;
  previous_product text;
begin
  perform public.lock_user_portfolio(p_user_id);

  select product_id into previous_product
  from public.transactions
  where id = p_transaction_id and user_id = p_user_id;

  if previous_product is null then
    raise exception 'İşlem bulunamadı.' using errcode = 'P0002';
  end if;

  update public.transactions
  set product_id = p_product_id,
      side = p_side,
      quantity = p_quantity,
      unit = p_unit,
      traded_at = p_traded_at,
      unit_price = p_unit_price,
      fee_amount = p_fee_amount,
      note = coalesce(p_note, ''),
      updated_at = now()
  where id = p_transaction_id and user_id = p_user_id
  returning * into updated;

  perform public.assert_no_oversell(p_user_id, p_product_id);
  if previous_product is distinct from p_product_id then
    perform public.assert_no_oversell(p_user_id, previous_product);
  end if;

  return updated;
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
  removed public.transactions;
begin
  perform public.lock_user_portfolio(p_user_id);

  delete from public.transactions
  where id = p_transaction_id and user_id = p_user_id
  returning * into removed;

  if removed.id is null then
    raise exception 'İşlem bulunamadı.' using errcode = 'P0002';
  end if;

  -- Bir alışın silinmesi sonraki satışları geçersiz kılıyorsa işlem geri alınır.
  perform public.assert_no_oversell(p_user_id, removed.product_id);
  return removed;
end;
$$;

-- Bu fonksiyonlar YALNIZCA sunucu (service_role) tarafından çağrılır.
revoke all on function public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text) from public;
revoke all on function public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text) from public;
revoke all on function public.delete_transaction_checked(uuid, uuid) from public;
revoke all on function public.assert_no_oversell(uuid, text) from public;
revoke all on function public.lock_user_portfolio(uuid) from public;

-- -----------------------------------------------------------------------------
-- 5. DAĞITIK GİRİŞ HIZ SINIRLAYICI
-- -----------------------------------------------------------------------------

/**
 * Ham IP veya kullanıcı adı SAKLANMAZ; yalnızca RATE_LIMIT_PEPPER ile
 * hesaplanan HMAC-SHA256 özeti tutulur.
 */
create table if not exists public.login_rate_limits (
  key_hash text primary key,
  failure_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  lock_level integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists login_rate_limits_updated_idx
  on public.login_rate_limits (updated_at);

comment on table public.login_rate_limits is
  'Dağıtık giriş hız sınırlayıcı. Ham IP/kullanıcı adı içermez; yalnızca peppered HMAC özeti.';

alter table public.login_rate_limits enable row level security;
alter table public.login_rate_limits force row level security;
-- Bilinçli olarak POLİTİKA TANIMLANMAMIŞTIR: yalnızca service_role erişir.

create or replace function public.login_rate_limit_check(
  p_key_hash text,
  p_max_attempts integer,
  p_window_ms integer,
  p_base_lock_ms integer,
  p_max_lock_ms integer
)
returns table (allowed boolean, remaining integer, retry_after_ms integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  row_record public.login_rate_limits;
  window_start timestamptz := now() - make_interval(secs => p_window_ms / 1000.0);
  attempts integer := 0;
begin
  select * into row_record from public.login_rate_limits where key_hash = p_key_hash;

  if row_record.key_hash is null then
    return query select true, p_max_attempts, 0;
    return;
  end if;

  if row_record.locked_until is not null and row_record.locked_until > now() then
    return query
      select false, 0,
             greatest(0, (extract(epoch from (row_record.locked_until - now())) * 1000)::integer);
    return;
  end if;

  if row_record.window_started_at > window_start then
    attempts := row_record.failure_count;
  end if;

  return query select true, greatest(0, p_max_attempts - attempts), 0;
end;
$$;

create or replace function public.login_rate_limit_record_failure(
  p_key_hash text,
  p_max_attempts integer,
  p_window_ms integer,
  p_base_lock_ms integer,
  p_max_lock_ms integer
)
returns table (allowed boolean, remaining integer, retry_after_ms integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  row_record public.login_rate_limits;
  window_start timestamptz := now() - make_interval(secs => p_window_ms / 1000.0);
  attempts integer;
  next_lock_level integer;
  lock_ms integer;
begin
  -- Satır kilitlenerek okunur; eşzamanlı denemeler sırayla işlenir.
  insert into public.login_rate_limits (key_hash, failure_count, window_started_at)
  values (p_key_hash, 0, now())
  on conflict (key_hash) do nothing;

  select * into row_record
  from public.login_rate_limits
  where key_hash = p_key_hash
  for update;

  if row_record.window_started_at <= window_start then
    -- Pencere doldu: sayaç sıfırlanır.
    attempts := 1;
    update public.login_rate_limits
    set failure_count = 1, window_started_at = now(), updated_at = now()
    where key_hash = p_key_hash;
  else
    attempts := row_record.failure_count + 1;
    update public.login_rate_limits
    set failure_count = attempts, updated_at = now()
    where key_hash = p_key_hash;
  end if;

  if attempts >= p_max_attempts then
    next_lock_level := row_record.lock_level + 1;
    lock_ms := least(p_base_lock_ms * power(2, next_lock_level - 1)::integer, p_max_lock_ms);

    update public.login_rate_limits
    set failure_count = 0,
        window_started_at = now(),
        lock_level = next_lock_level,
        locked_until = now() + make_interval(secs => lock_ms / 1000.0),
        updated_at = now()
    where key_hash = p_key_hash;

    return query select false, 0, lock_ms;
    return;
  end if;

  return query select true, greatest(0, p_max_attempts - attempts), 0;
end;
$$;

create or replace function public.login_rate_limit_reset(p_key_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.login_rate_limits where key_hash = p_key_hash;
end;
$$;

/** Uzun süredir dokunulmamış sayaçları temizler (zamanlanmış görev için). */
create or replace function public.login_rate_limit_cleanup(p_older_than_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.login_rate_limits
  where updated_at < now() - make_interval(hours => p_older_than_hours)
    and (locked_until is null or locked_until < now());
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.login_rate_limit_check(text, integer, integer, integer, integer) from public;
revoke all on function public.login_rate_limit_record_failure(text, integer, integer, integer, integer) from public;
revoke all on function public.login_rate_limit_reset(text) from public;
revoke all on function public.login_rate_limit_cleanup(integer) from public;

-- -----------------------------------------------------------------------------
-- 6. DENETİM KAYDININ DEĞİŞTİRİLEMEZLİĞİ
-- -----------------------------------------------------------------------------

/**
 * Denetim kayıtları yalnızca RLS ile değil, TETİKLEYİCİ düzeyinde de
 * değiştirilemez ve silinemez. Bu kural service_role için de geçerlidir.
 */
create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Denetim kayıtları değiştirilemez ve silinemez.' using errcode = '42501';
end;
$$;

drop trigger if exists admin_audit_logs_no_update on public.admin_audit_logs;
create trigger admin_audit_logs_no_update
  before update on public.admin_audit_logs
  for each row execute function public.reject_audit_mutation();

drop trigger if exists admin_audit_logs_no_delete on public.admin_audit_logs;
create trigger admin_audit_logs_no_delete
  before delete on public.admin_audit_logs
  for each row execute function public.reject_audit_mutation();

comment on table public.admin_audit_logs is
  'Yönetici işlem kayıtları. Parola, oturum jetonu, ham IP ve finansal detay içermez. Tetikleyici ile değiştirilemez.';
