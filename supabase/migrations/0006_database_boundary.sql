-- =============================================================================
-- Altın Takip — 0006 Veritabanı yetki sınırı
--
-- Mimari karar: tarayıcı Supabase'e doğrudan yazmaz. Bütün mutation'lar
-- Next.js BFF -> doğrulanmış app_session -> markalanmış actor/scope ->
-- server-only secret/service-role client -> PostgreSQL yolundan geçer.
-- Bu yol RLS'yi ATLAR; birincil sınır sunucu tarafı actor authorization'dır.
--
-- Bu migration, BFF'nin atlanmasını (Data API'ye anon/authenticated JWT ile
-- doğrudan erişim) engelleyecek biçimde PostgreSQL yetkilerini minimuma indirir:
--
--  1. Kritik SECURITY DEFINER fonksiyonları yalnızca service_role çağırabilir;
--     dahili yardımcılar hiçbir istemci rolüne açık değildir.
--  2. anon/authenticated rolleri kişisel ve finansal tablolara DOĞRUDAN YAZAMAZ
--     (INSERT/UPDATE/DELETE grant'ları kaldırılır). authenticated yalnızca
--     kendi satırlarını SELECT edebilir (RLS ile).
--  3. 0002'deki doğrudan yazma politikaları kaldırılır.
--  4. Varsayılan portföy ve tercih kayıtları profil oluşturulurken tetikleyici
--     ile, idempotent biçimde hazırlanır; GET yolları veri OLUŞTURMAZ.
--
-- Tablo GRANT'ları ve RLS politikaları İKİ AYRI KATMANDIR: GRANT "bu rol bu
-- tabloya bu işlemi hiç yapabilir mi?" sorusunu, RLS "hangi satırlara?"
-- sorusunu yanıtlar. İkisi de bağımsız olarak test edilir.
--
-- Eski migration'lar değiştirilmez; 0001-0005 uygulanmış bir veritabanına
-- güvenle uygulanır ve tekrar çalıştırılabilir (idempotent).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. FONKSİYON YETKİLERİ
-- -----------------------------------------------------------------------------

-- Supabase varsayılan olarak public şemasındaki her fonksiyona anon,
-- authenticated ve service_role için EXECUTE verir. "revoke from public"
-- tek başına yeterli DEĞİLDİR; her rolden açıkça alınmalıdır.

-- 1a. Üst seviye BFF RPC'leri: YALNIZCA service_role.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.purge_expired_sessions()',
    'public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text)',
    'public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text)',
    'public.delete_transaction_checked(uuid, uuid)',
    'public.login_rate_limit_check(text, integer, integer, integer, integer)',
    'public.login_rate_limit_record_failure(text, integer, integer, integer, integer)',
    'public.login_rate_limit_reset(text)',
    'public.login_rate_limit_cleanup(integer)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- 1b. Dahili yardımcılar ve tetikleyici fonksiyonları: HİÇBİR role açık değil.
-- SECURITY DEFINER fonksiyonları bunları sahip (postgres) yetkisiyle çağırır;
-- tetikleyiciler EXECUTE yetkisine bakmaz. service_role'ün de doğrudan
-- çağırmasına gerek yoktur.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.assert_no_oversell(uuid, text)',
    'public.lock_user_portfolio(uuid)',
    'public.reject_audit_mutation()',
    'public.enforce_transaction_unit()',
    'public.touch_updated_at()',
    'public.prevent_profile_privilege_escalation()'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
end;
$$;

-- 1c. RLS politikalarının kullandığı yardımcılar: authenticated KORUNUR.
revoke all on function public.current_role_name() from public;
revoke all on function public.current_role_name() from anon;
revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.current_role_name() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- 1d. Gelecekte oluşturulacak fonksiyonların otomatik olarak anon/authenticated
-- rolüne açılmasını engelle. Supabase'in varsayılanı "postgres" rolü için
-- tanımlıdır; bu migration postgres üyesi olarak çalışmıyorsa körlemesine
-- uygulanmaz, açık bir NOTICE verilir ve pgTAP testi bunu ayrıca doğrular.
do $$
begin
  if pg_has_role(current_user, 'postgres', 'MEMBER') then
    -- PostgreSQL yeni fonksiyonlara örtük olarak PUBLIC için EXECUTE verir ve
    -- şema düzeyindeki varsayılan ACL'yi GLOBAL (şemasız) varsayılanla
    -- birleştirir. Yalnızca şema düzeyinde "revoke from public" yeterli
    -- DEĞİLDİR; global varsayılandaki PUBLIC EXECUTE da kapatılmalıdır.
    -- (pgTAP testi "ALTER DEFAULT PRIVILEGES" bunu gerçek fonksiyonla doğrular.)
    alter default privileges for role postgres
      revoke execute on functions from public;
    alter default privileges for role postgres in schema public
      revoke execute on functions from public;
    alter default privileges for role postgres in schema public
      revoke execute on functions from anon, authenticated;
    raise notice 'Varsayılan fonksiyon yetkileri public/anon/authenticated için kapatıldı.';
  else
    raise notice
      'Migration rolü (%) postgres üyesi değil; ALTER DEFAULT PRIVILEGES atlandı. Manuel uygulayın.',
      current_user;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. TABLO YETKİLERİ — DATA API DOĞRUDAN YAZMA YÜZEYİ KAPATILIR
-- -----------------------------------------------------------------------------

-- 2a. Kişisel / finansal tablolar: anon HİÇBİR ŞEY yapamaz; authenticated
-- yalnızca SELECT (satır kapsamı RLS ile). Yazma yalnızca BFF (service_role).
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'public.profiles',
    'public.portfolios',
    'public.transactions',
    'public.user_preferences'
  ]
  loop
    execute format('revoke all on table %s from public', tbl);
    execute format('revoke all on table %s from anon', tbl);
    execute format('revoke all on table %s from authenticated', tbl);
    execute format('grant select on table %s to authenticated', tbl);
    execute format('grant select, insert, update, delete on table %s to service_role', tbl);
  end loop;
end;
$$;

-- 2b. Oturum ve hız sınırı tabloları: hiçbir istemci rolüne açık değil.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['public.app_sessions', 'public.login_rate_limits']
  loop
    execute format('revoke all on table %s from public', tbl);
    execute format('revoke all on table %s from anon', tbl);
    execute format('revoke all on table %s from authenticated', tbl);
    execute format('grant select, insert, update, delete on table %s to service_role', tbl);
  end loop;
end;
$$;

-- 2c. Denetim kaydı: authenticated yalnızca SELECT (RLS yalnızca admin'e açar);
-- INSERT yalnızca service_role; UPDATE/DELETE HİÇBİR role (tetikleyici de engeller).
revoke all on table public.admin_audit_logs from public;
revoke all on table public.admin_audit_logs from anon;
revoke all on table public.admin_audit_logs from authenticated;
revoke all on table public.admin_audit_logs from service_role;
grant select on table public.admin_audit_logs to authenticated;
grant select, insert on table public.admin_audit_logs to service_role;

-- 2d. Katalog ve fiyat tabloları: istemci doğrudan sorgulamaz; yalnızca
-- authenticated SELECT bırakılır. anon hiçbir şey okuyamaz.
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'public.gold_products',
    'public.price_sources',
    'public.current_prices'
  ]
  loop
    execute format('revoke all on table %s from public', tbl);
    execute format('revoke all on table %s from anon', tbl);
    execute format('revoke all on table %s from authenticated', tbl);
    execute format('grant select on table %s to authenticated', tbl);
    execute format('grant select, insert, update, delete on table %s to service_role', tbl);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. DOĞRUDAN YAZMA POLİTİKALARI KALDIRILIR
-- -----------------------------------------------------------------------------

-- GRANT katmanı yazmayı zaten engeller; politikalar da kaldırılır ki
-- "ileride biri grant verirse" bile RLS yazmaya izin vermesin.
drop policy if exists portfolios_insert_own on public.portfolios;
drop policy if exists portfolios_update_own on public.portfolios;
drop policy if exists portfolios_delete_own on public.portfolios;

drop policy if exists transactions_insert_own on public.transactions;
drop policy if exists transactions_update_own on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;

drop policy if exists user_preferences_all_own on public.user_preferences;
drop policy if exists user_preferences_select_own on public.user_preferences;
create policy user_preferences_select_own on public.user_preferences
  for select to authenticated
  using (user_id = auth.uid());

-- Profil artık istemci için salt okunurdur. Görünen ad değişikliği BFF
-- üzerinden, sınırlı bir servis işlemiyle yapılır.
drop policy if exists profiles_update_self on public.profiles;

-- SELECT politikaları (0002) KORUNUR:
--   profiles_select_self_or_admin, portfolios_select_own,
--   transactions_select_own, admin_audit_logs_select_admin,
--   gold_products_select, price_sources_select, current_prices_select

-- -----------------------------------------------------------------------------
-- 4. VARSAYILAN PORTFÖY PROVISIONING
-- -----------------------------------------------------------------------------

/**
 * Bir profil için varsayılan portföy ve tercih kaydını hazırlar.
 * İdempotenttir: mevcut kayıt varsa dokunmaz. Kaç kayıt oluşturduğunu döner.
 */
create or replace function public.provision_user_defaults(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  created integer := 0;
  affected integer;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Profil bulunamadı: %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.portfolios (user_id, name)
  values (p_user_id, 'Portföyüm')
  on conflict (user_id) do nothing;
  get diagnostics affected = row_count;
  created := created + affected;

  insert into public.user_preferences (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  get diagnostics affected = row_count;
  created := created + affected;

  return created;
end;
$$;

/**
 * profiles AFTER INSERT tetikleyicisi: profil ile portföy/tercih kayıtları
 * AYNI transaction içinde oluşur. Portföy yazılamazsa profil de yazılmaz;
 * yarım hesap kalmaz.
 */
create or replace function public.provision_user_defaults_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.provision_user_defaults(new.id);
  return new;
end;
$$;

drop trigger if exists profiles_provision_defaults on public.profiles;
create trigger profiles_provision_defaults
  after insert on public.profiles
  for each row execute function public.provision_user_defaults_trigger();

/**
 * Onarım: profili olup portföyü veya tercihi olmayan kullanıcıları tamamlar.
 * Yalnızca service_role (BFF yönetim yolu) çağırabilir. İdempotenttir.
 */
create or replace function public.provision_missing_defaults()
returns table (user_id uuid, created_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  row_record record;
  created integer;
begin
  for row_record in
    select p.id
    from public.profiles p
    where not exists (select 1 from public.portfolios pf where pf.user_id = p.id)
       or not exists (select 1 from public.user_preferences up where up.user_id = p.id)
  loop
    created := public.provision_user_defaults(row_record.id);
    user_id := row_record.id;
    created_rows := created;
    return next;
  end loop;
end;
$$;

-- Mevcut veriyi bir kez onar (idempotent).
do $$
declare
  repaired integer;
begin
  select count(*) into repaired from public.provision_missing_defaults();
  if repaired > 0 then
    raise notice '% kullanıcı için eksik portföy/tercih kaydı tamamlandı.', repaired;
  end if;
end;
$$;

/**
 * lock_user_portfolio artık portföy OLUŞTURMAZ. Portföy yoksa açık hata verir;
 * provisioning tetikleyici/onarım fonksiyonunun işidir.
 */
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
    raise exception 'ALTIN_PORTFOLIO_NOT_PROVISIONED: % kullanıcısının portföyü yok.', p_user_id
      using errcode = 'P0002';
  end if;

  return portfolio_id;
end;
$$;

-- Yeni fonksiyonların yetkileri
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.provision_user_defaults(uuid)',
    'public.provision_user_defaults_trigger()',
    'public.provision_missing_defaults()',
    'public.lock_user_portfolio(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
  end loop;
  -- Yalnızca onarım komutu BFF'den çağrılır.
  grant execute on function public.provision_missing_defaults() to service_role;
end;
$$;

comment on function public.provision_missing_defaults() is
  'Yönetici onarımı: eksik portföy/tercih kayıtlarını idempotent biçimde tamamlar. Yalnızca service_role.';
