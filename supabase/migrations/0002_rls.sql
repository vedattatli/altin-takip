-- =============================================================================
-- Altın Takip — 0002 Satır Düzeyi Güvenlik (RLS)
--
-- İLKELER
-- 1. RLS her tabloda VARSAYILAN OLARAK AÇIKTIR. Politika yoksa erişim yoktur.
-- 2. Normal kullanıcı yalnızca kendi profilini, portföyünü, işlemlerini ve
--    tercihlerini okuyup değiştirebilir.
-- 3. Normal kullanıcı kullanıcı listesine erişemez ve rolünü değiştiremez.
-- 4. Yönetici kullanıcı listesini ve portföyleri GÖRÜNTÜLEYEBİLİR; ilk sürümde
--    kullanıcı adına finansal kayıt DÜZENLEYEMEZ (yazma politikası verilmemiştir).
-- 5. service_role anahtarı RLS'yi atlar ve YALNIZCA sunucu kodunda kullanılır.
--    Arayüzde menü gizlemek güvenlik önlemi sayılmaz.
-- =============================================================================

-- --------------------------------------------------------------- yardımcılar

-- SECURITY DEFINER: politikalar içinde profiles'a bakarken RLS özyinelemesini önler.
create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.status = 'active'
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role_name() = 'admin', false);
$$;

revoke all on function public.current_role_name() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.current_role_name() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ------------------------------------------------------------------ profiles

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Kullanıcı yalnızca kendi satırını güncelleyebilir. Rol/durum değişikliği
-- aşağıdaki tetikleyici tarafından ayrıca engellenir.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Profil oluşturma ve silme yalnızca sunucu (service_role) üzerinden yapılır.
-- authenticated rolüne INSERT/DELETE politikası bilinçli olarak verilmemiştir.

-- Yetki yükseltmeyi veritabanı düzeyinde engelle: kullanıcı kendini admin yapamaz,
-- kendini aktifleştiremez, kullanıcı adını değiştiremez.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role ve postgres RLS dışıdır; yönetim işlemleri sunucudan yapılır.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'Rol değiştirilemez.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'Hesap durumu değiştirilemez.' using errcode = '42501';
  end if;
  if new.username is distinct from old.username then
    raise exception 'Kullanıcı adı değiştirilemez.' using errcode = '42501';
  end if;
  if new.must_change_password is distinct from old.must_change_password then
    raise exception 'Bu alan değiştirilemez.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_prevent_escalation on public.profiles;
create trigger profiles_prevent_escalation
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();

-- -------------------------------------------------------------- app_sessions

-- Oturum tablosuna hiçbir istemci erişemez; yalnızca service_role kullanır.
alter table public.app_sessions enable row level security;
alter table public.app_sessions force row level security;
-- Bilinçli olarak POLİTİKA TANIMLANMAMIŞTIR.

-- --------------------------------------------------------------- portfolios

alter table public.portfolios enable row level security;
alter table public.portfolios force row level security;

drop policy if exists portfolios_select_own on public.portfolios;
create policy portfolios_select_own on public.portfolios
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists portfolios_insert_own on public.portfolios;
create policy portfolios_insert_own on public.portfolios
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists portfolios_update_own on public.portfolios;
create policy portfolios_update_own on public.portfolios
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists portfolios_delete_own on public.portfolios;
create policy portfolios_delete_own on public.portfolios
  for delete to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------- transactions

alter table public.transactions enable row level security;
alter table public.transactions force row level security;

-- Yönetici SALT OKUNUR görebilir; yazma politikalarında admin istisnası YOKTUR.
drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own on public.transactions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own on public.transactions
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists transactions_update_own on public.transactions;
create policy transactions_update_own on public.transactions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists transactions_delete_own on public.transactions;
create policy transactions_delete_own on public.transactions
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------- user_preferences

alter table public.user_preferences enable row level security;
alter table public.user_preferences force row level security;

drop policy if exists user_preferences_all_own on public.user_preferences;
create policy user_preferences_all_own on public.user_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ------------------------------------------------- referans (okuma serbest)

alter table public.gold_products enable row level security;
alter table public.gold_products force row level security;

drop policy if exists gold_products_select on public.gold_products;
create policy gold_products_select on public.gold_products
  for select to authenticated
  using (true);

alter table public.price_sources enable row level security;
alter table public.price_sources force row level security;

drop policy if exists price_sources_select on public.price_sources;
create policy price_sources_select on public.price_sources
  for select to authenticated
  using (true);

alter table public.current_prices enable row level security;
alter table public.current_prices force row level security;

drop policy if exists current_prices_select on public.current_prices;
create policy current_prices_select on public.current_prices
  for select to authenticated
  using (true);

-- Katalog ve fiyat yazımı yalnızca service_role ile yapılır; politika verilmemiştir.

-- ---------------------------------------------------------- admin_audit_logs

alter table public.admin_audit_logs enable row level security;
alter table public.admin_audit_logs force row level security;

-- Yalnızca yönetici okuyabilir. Normal kullanıcı denetim kayıtlarını göremez.
drop policy if exists admin_audit_logs_select_admin on public.admin_audit_logs;
create policy admin_audit_logs_select_admin on public.admin_audit_logs
  for select to authenticated
  using (public.is_admin());

-- Kayıtlar değiştirilemez ve silinemez: UPDATE/DELETE politikası yoktur.
-- Yazma sunucu tarafından (service_role) yapılır.
