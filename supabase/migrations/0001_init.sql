-- =============================================================================
-- Altın Takip — 0001 Şema
--
-- Uygulama tablolarında PAROLA veya PAROLA HASH'İ TUTULMAZ.
-- Parola custody'si tamamen Supabase Auth'a (auth.users) aittir.
-- Kullanıcı adı, sunucuda deterministik olarak dahili bir e-posta kimliğine
-- çevrilir; bu adres hiçbir uygulama tablosunda ve arayüzde gösterilmez.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Normalize edilmiş kullanıcı adı. Her zaman küçük harftir (uygulama katmanı
  -- normalize eder, aşağıdaki CHECK ile veritabanında da zorlanır).
  username text not null,
  display_name text not null,
  role text not null default 'user',
  status text not null default 'active',
  -- Geçici parola atanmış kullanıcı, parolasını değiştirene kadar uygulamayı kullanamaz.
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,

  constraint profiles_role_check check (role in ('admin', 'user')),
  constraint profiles_status_check check (status in ('active', 'inactive')),
  constraint profiles_username_lowercase check (username = lower(username)),
  constraint profiles_username_format check (username ~ '^[a-z][a-z0-9._-]{2,31}$'),
  constraint profiles_display_name_length check (char_length(display_name) between 2 and 80)
);

-- Kullanıcı adı BÜYÜK/KÜÇÜK HARFE DUYARSIZ biçimde benzersizdir.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_status_idx on public.profiles (status);

comment on table public.profiles is
  'Kullanıcı profili. Parola bilgisi İÇERMEZ; kimlik doğrulama auth.users üzerinden yapılır.';

-- ------------------------------------------------------------ app_sessions

-- Uygulamanın kendi oturum tablosu. Parola sıfırlama veya pasifleştirme
-- işleminde satırlar silinerek TÜM cihazlardaki oturumlar geçersiz kılınır.
create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Çerezdeki jetonun kendisi DEĞİL, SHA-256 özeti saklanır.
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_user_id_idx on public.app_sessions (user_id);
create index if not exists app_sessions_expires_at_idx on public.app_sessions (expires_at);

-- ----------------------------------------------------------- gold_products

create table if not exists public.gold_products (
  id text primary key,
  name text not null,
  category text not null,
  unit text not null,
  milyem numeric(5, 4) not null,
  gram_weight numeric(10, 4) not null,
  pure_gold_per_unit numeric(10, 4) not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,

  constraint gold_products_category_check check (category in ('gram', 'kulce', 'ziynet', 'ayarli')),
  constraint gold_products_unit_check check (unit in ('gram', 'adet')),
  constraint gold_products_milyem_check check (milyem > 0 and milyem <= 1)
);

-- ------------------------------------------------------------- portfolios

create table if not exists public.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default 'Portföyüm',
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint portfolios_name_length check (char_length(name) between 1 and 80)
);

create index if not exists portfolios_user_id_idx on public.portfolios (user_id);

-- ------------------------------------------------------------ transactions

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  -- user_id, RLS filtrelemesinin ana alanıdır ve indekslidir.
  user_id uuid not null references public.profiles (id) on delete cascade,
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  product_id text not null references public.gold_products (id),
  side text not null,
  quantity numeric(18, 6) not null,
  unit text not null,
  traded_at date not null,
  unit_price numeric(18, 2) not null,
  fee_amount numeric(18, 2) not null default 0,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transactions_side_check check (side in ('buy', 'sell')),
  constraint transactions_unit_check check (unit in ('gram', 'adet')),
  -- Negatif veya sıfır miktar kabul edilmez; yön "side" alanında tutulur.
  constraint transactions_quantity_positive check (quantity > 0),
  constraint transactions_unit_price_positive check (unit_price > 0),
  constraint transactions_fee_non_negative check (fee_amount >= 0),
  constraint transactions_note_length check (char_length(note) <= 280)
);

create index if not exists transactions_user_id_idx on public.transactions (user_id);
create index if not exists transactions_portfolio_id_idx on public.transactions (portfolio_id);
create index if not exists transactions_user_product_idx on public.transactions (user_id, product_id);
create index if not exists transactions_user_traded_at_idx on public.transactions (user_id, traded_at);

-- ------------------------------------------------------------ price_sources

create table if not exists public.price_sources (
  id text primary key,
  label text not null,
  market text not null,
  -- false ise bu kaynak GERÇEK piyasa verisi vermez; arayüz bunu göstermek zorundadır.
  is_real_market_data boolean not null default false,
  disclaimer text not null default '',
  stale_after_seconds integer not null default 300,
  is_active boolean not null default true
);

-- ----------------------------------------------------------- current_prices

create table if not exists public.current_prices (
  source_id text not null references public.price_sources (id) on delete cascade,
  product_id text not null references public.gold_products (id) on delete cascade,
  -- ALIŞ ve SATIŞ ayrı sütunlardır; biri diğerinden TÜRETİLMEZ.
  buy_price numeric(18, 2) not null,
  sell_price numeric(18, 2) not null,
  currency text not null default 'TRY',
  market text not null,
  provider_timestamp timestamptz not null,
  fetched_at timestamptz not null default now(),
  status text not null default 'ok',

  primary key (source_id, product_id),
  constraint current_prices_status_check check (status in ('ok', 'stale', 'unavailable')),
  constraint current_prices_positive check (buy_price > 0 and sell_price > 0),
  -- Piyasa alışı satıştan büyük olamaz; ters kayıt veritabanı düzeyinde engellenir.
  constraint current_prices_spread_check check (buy_price <= sell_price)
);

create index if not exists current_prices_product_idx on public.current_prices (product_id);

-- --------------------------------------------------------- user_preferences

create table if not exists public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  default_product_id text references public.gold_products (id),
  locale text not null default 'tr-TR',
  currency text not null default 'TRY',
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------- admin_audit_logs

-- Yönetici işlemlerinin denetim kaydı.
-- Parola, parola özeti veya finansal içerik BU TABLOYA YAZILMAZ.
create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  admin_username text not null,
  target_user_id uuid,
  target_username text,
  action text not null,
  success boolean not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint admin_audit_logs_action_check check (
    action in (
      'user.create',
      'user.deactivate',
      'user.activate',
      'user.password_reset',
      'user.view',
      'user.portfolio_view',
      'user.delete_attempt',
      'user.delete'
    )
  )
);

create index if not exists admin_audit_logs_admin_idx on public.admin_audit_logs (admin_user_id);
create index if not exists admin_audit_logs_target_idx on public.admin_audit_logs (target_user_id);
create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);

comment on table public.admin_audit_logs is
  'Yönetici işlem kayıtları. Parola ve finansal detay içermez. Değiştirilemez ve silinemez.';

-- ------------------------------------------------------------- updated_at

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists portfolios_touch_updated_at on public.portfolios;
create trigger portfolios_touch_updated_at
  before update on public.portfolios
  for each row execute function public.touch_updated_at();

drop trigger if exists transactions_touch_updated_at on public.transactions;
create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function public.touch_updated_at();
