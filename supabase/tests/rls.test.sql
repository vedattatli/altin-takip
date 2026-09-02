-- =============================================================================
-- Altın Takip — veritabanı yetki sınırı ve RLS davranış testleri (pgTAP)
--
-- Çalıştırma:  npm run test:db      (Supabase CLI + Docker gerektirir)
--              supabase test db
--
-- Bu testler POLİTİKALARIN VE GRANT'LARIN GERÇEKTEN uygulandığını doğrular;
-- SQL metnini okumakla yetinmez. Her test ilgili rolü üstlenip
-- (authenticated / anon / service_role) auth.uid() değerini ayarlayarak
-- gerçek bir Data API istemcisi gibi sorgu çalıştırır.
--
-- İKİ KATMAN, İKİ FARKLI HATA
--   GRANT katmanı  : 42501 "permission denied for table X"   (rol tabloya hiç yazamaz)
--   RLS katmanı    : 42501 "... violates row-level security policy ..." (satır kapsamı)
--   Bütünlük       : 23503 composite FK, 23514 check/trigger, P0001/P0002 iş kuralı
-- Hangi katmanın reddettiği hata mesajıyla KANITLANIR.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(73);

-- -----------------------------------------------------------------------------
-- Yardımcılar
-- -----------------------------------------------------------------------------

create schema if not exists tests;

/** Belirtilen kullanıcı kimliğiyle "authenticated" rolüne geçer. */
create or replace function tests.authenticate_as(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
end;
$$;

/** Oturumsuz (anon) role geçer. */
create or replace function tests.become_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end;
$$;

/** Kurulum ve sahip bağlamı için tam yetkili role döner (RLS'yi atlar; BFF gibi). */
create or replace function tests.become_service()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Rol değiştirme yardımcıları her rolden çağrılabilmelidir (test kapsamı; rollback edilir).
grant usage on schema tests to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Test verisi (BFF / sahip bağlamında)
-- -----------------------------------------------------------------------------

select tests.become_service();

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a@users.altin-takip.invalid', 'x', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'b@users.altin-takip.invalid', 'x', now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'admin@users.altin-takip.invalid', 'x', now(), now(), now()),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c@users.altin-takip.invalid', 'x', now(), now(), now());

-- Profil eklenince portföy ve tercih kaydı TETİKLEYİCİ ile oluşur.
insert into public.profiles (id, username, display_name, role, status, must_change_password)
values
  ('11111111-1111-1111-1111-111111111111', 'kullanicia', 'Kullanıcı A', 'user', 'active', false),
  ('22222222-2222-2222-2222-222222222222', 'kullanicib', 'Kullanıcı B', 'user', 'active', false),
  ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'Yönetici X', 'admin', 'active', false),
  ('44444444-4444-4444-4444-444444444444', 'kullanicic', 'Kullanıcı C', 'user', 'active', false);

-- =============================================================================
-- 1. PROVISIONING (tetikleyici + idempotent onarım)
-- =============================================================================

select is(
  (select count(*)::int from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Profil eklenince varsayılan portföy tetikleyiciyle oluşur'
);

select is(
  (select count(*)::int from public.user_preferences where user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Profil eklenince tercih kaydı tetikleyiciyle oluşur'
);

select is(
  public.provision_user_defaults('11111111-1111-1111-1111-111111111111'),
  0,
  'provision_user_defaults idempotenttir: ikinci çağrı 0 kayıt oluşturur'
);

-- Eksik portföy senaryosu: C kullanıcısının portföyü silinir.
delete from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444';

select throws_ok(
  $$select public.lock_user_portfolio('44444444-4444-4444-4444-444444444444')$$,
  'P0002',
  NULL,
  'lock_user_portfolio portföy OLUŞTURMAZ; yoksa ALTIN_PORTFOLIO_NOT_PROVISIONED hatası verir'
);

select is(
  (select count(*)::int from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444'),
  0,
  'lock_user_portfolio yan etkisizdir (hata sonrası portföy yine yok)'
);

select is(
  (select count(*)::int from public.provision_missing_defaults()),
  1,
  'provision_missing_defaults eksik portföyü olan tek kullanıcıyı onarır'
);

select is(
  (select count(*)::int from public.provision_missing_defaults()),
  0,
  'provision_missing_defaults idempotenttir: ikinci çağrı hiçbir şey yapmaz'
);

-- Test işlemleri (tetikleyicinin oluşturduğu portföy kimlikleriyle)
insert into public.transactions
  (id, user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price, fee_amount)
values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
   'gram-altin', 'buy', 10, 'gram', '2026-01-10', 5000, 0),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   (select id from public.portfolios where user_id = '22222222-2222-2222-2222-222222222222'),
   'gram-altin', 'buy', 4, 'gram', '2026-01-11', 5100, 0);

insert into public.admin_audit_logs (admin_user_id, admin_username, target_user_id, target_username, action, success)
values ('33333333-3333-3333-3333-333333333333', 'yoneticix',
        '11111111-1111-1111-1111-111111111111', 'kullanicia', 'user.view', true);

insert into public.app_sessions (id, user_id, token_hash, device_label, expires_at, absolute_expires_at)
values ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'ornek-token-ozeti', 'Chrome · Windows', now() + interval '180 days', now() + interval '180 days');

-- =============================================================================
-- 2. FONKSİYON YETKİ MATRİSİ (has_function_privilege)
-- =============================================================================

select ok(
  (select bool_and(not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.purge_expired_sessions()',
     'public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.delete_transaction_checked(uuid, uuid)',
     'public.login_rate_limit_check(text, integer, integer, integer, integer)',
     'public.login_rate_limit_record_failure(text, integer, integer, integer, integer)',
     'public.login_rate_limit_reset(text)',
     'public.login_rate_limit_cleanup(integer)'
   ]) as f),
  'anon hiçbir kritik SECURITY DEFINER RPC''yi çağıramaz'
);

select ok(
  (select bool_and(not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.purge_expired_sessions()',
     'public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.delete_transaction_checked(uuid, uuid)',
     'public.login_rate_limit_check(text, integer, integer, integer, integer)',
     'public.login_rate_limit_record_failure(text, integer, integer, integer, integer)',
     'public.login_rate_limit_reset(text)',
     'public.login_rate_limit_cleanup(integer)'
   ]) as f),
  'authenticated hiçbir kritik SECURITY DEFINER RPC''yi çağıramaz'
);

select ok(
  (select bool_and(has_function_privilege('service_role', f, 'execute'))
   from unnest(array[
     'public.purge_expired_sessions()',
     'public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text)',
     'public.delete_transaction_checked(uuid, uuid)',
     'public.login_rate_limit_check(text, integer, integer, integer, integer)',
     'public.login_rate_limit_record_failure(text, integer, integer, integer, integer)',
     'public.login_rate_limit_reset(text)',
     'public.login_rate_limit_cleanup(integer)',
     'public.provision_missing_defaults()'
   ]) as f),
  'service_role (BFF) üst seviye RPC''leri çağırabilir'
);

select ok(
  (select bool_and(
     not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute')
     and not has_function_privilege('service_role', f, 'execute'))
   from unnest(array[
     'public.assert_no_oversell(uuid, text)',
     'public.lock_user_portfolio(uuid)',
     'public.reject_audit_mutation()',
     'public.enforce_transaction_unit()',
     'public.touch_updated_at()',
     'public.prevent_profile_privilege_escalation()',
     'public.provision_user_defaults(uuid)',
     'public.provision_user_defaults_trigger()'
   ]) as f),
  'Dahili yardımcılar ve tetikleyici fonksiyonları HİÇBİR role açık değildir'
);

select ok(
  has_function_privilege('authenticated', 'public.current_role_name()', 'execute')
  and has_function_privilege('authenticated', 'public.is_admin()', 'execute'),
  'RLS yardımcıları (current_role_name, is_admin) authenticated için korunur'
);

select ok(
  not has_function_privilege('anon', 'public.current_role_name()', 'execute')
  and not has_function_privilege('anon', 'public.is_admin()', 'execute'),
  'RLS yardımcıları anon için kapalıdır'
);

-- Varsayılan yetkiler: bundan sonra oluşturulan fonksiyon otomatik açılmaz.
create function public.altin_test_probe() returns integer language sql as 'select 1';

select ok(
  not has_function_privilege('anon', 'public.altin_test_probe()', 'execute')
  and not has_function_privilege('authenticated', 'public.altin_test_probe()', 'execute'),
  'ALTER DEFAULT PRIVILEGES: yeni fonksiyonlar anon/authenticated için otomatik açılmaz'
);

-- =============================================================================
-- 3. TABLO YETKİ MATRİSİ (has_table_privilege) — GRANT katmanı
-- =============================================================================

select ok(
  (select bool_and(
     not has_table_privilege('anon', t, 'SELECT')
     and not has_table_privilege('anon', t, 'INSERT')
     and not has_table_privilege('anon', t, 'UPDATE')
     and not has_table_privilege('anon', t, 'DELETE'))
   from unnest(array[
     'public.profiles', 'public.portfolios', 'public.transactions', 'public.user_preferences',
     'public.app_sessions', 'public.login_rate_limits', 'public.admin_audit_logs',
     'public.gold_products', 'public.price_sources', 'public.current_prices'
   ]) as t),
  'anon hiçbir tabloyu okuyamaz ve yazamaz'
);

select ok(
  (select bool_and(has_table_privilege('authenticated', t, 'SELECT'))
   from unnest(array[
     'public.profiles', 'public.portfolios', 'public.transactions', 'public.user_preferences',
     'public.admin_audit_logs', 'public.gold_products', 'public.price_sources', 'public.current_prices'
   ]) as t),
  'authenticated yalnızca SELECT alır (satır kapsamı RLS ile)'
);

select ok(
  (select bool_and(
     not has_table_privilege('authenticated', t, 'INSERT')
     and not has_table_privilege('authenticated', t, 'UPDATE')
     and not has_table_privilege('authenticated', t, 'DELETE'))
   from unnest(array[
     'public.profiles', 'public.portfolios', 'public.transactions', 'public.user_preferences',
     'public.app_sessions', 'public.login_rate_limits', 'public.admin_audit_logs',
     'public.gold_products', 'public.price_sources', 'public.current_prices'
   ]) as t),
  'authenticated hiçbir tabloya INSERT/UPDATE/DELETE yapamaz (Data API yazma yüzeyi kapalı)'
);

select ok(
  not has_table_privilege('authenticated', 'public.app_sessions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.login_rate_limits', 'SELECT'),
  'app_sessions ve login_rate_limits authenticated için tamamen kapalıdır'
);

select ok(
  (select bool_and(
     has_table_privilege('service_role', t, 'SELECT')
     and has_table_privilege('service_role', t, 'INSERT')
     and has_table_privilege('service_role', t, 'UPDATE')
     and has_table_privilege('service_role', t, 'DELETE'))
   from unnest(array[
     'public.profiles', 'public.portfolios', 'public.transactions', 'public.user_preferences',
     'public.app_sessions', 'public.login_rate_limits'
   ]) as t),
  'service_role (BFF) kişisel/finansal/oturum tablolarında tam yetkilidir'
);

select ok(
  has_table_privilege('service_role', 'public.admin_audit_logs', 'SELECT')
  and has_table_privilege('service_role', 'public.admin_audit_logs', 'INSERT')
  and not has_table_privilege('service_role', 'public.admin_audit_logs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.admin_audit_logs', 'DELETE'),
  'Denetim kaydı: service_role yalnızca SELECT+INSERT; UPDATE/DELETE grant''ı yok'
);

-- =============================================================================
-- 4. KULLANICI A — gerçek authenticated JWT bağlamı
-- =============================================================================

select tests.authenticate_as('11111111-1111-1111-1111-111111111111');

select is((select count(*)::int from public.profiles), 1,
  'Kullanıcı A yalnızca kendi profilini görebilir');

select is((select username from public.profiles), 'kullanicia',
  'Kullanıcı A görebildiği tek profil kendisininkidir');

select is((select count(*)::int from public.portfolios), 1,
  'Kullanıcı A yalnızca kendi portföyünü görebilir');

select is((select count(*)::int from public.transactions), 1,
  'Kullanıcı A yalnızca kendi işlemlerini görebilir');

select is((select count(*)::int from public.user_preferences), 1,
  'Kullanıcı A yalnızca kendi tercihlerini görebilir');

select is(
  (select count(*)::int from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  0, 'Kullanıcı A, Kullanıcı B profilini okuyamaz');

select is(
  (select count(*)::int from public.portfolios where user_id = '22222222-2222-2222-2222-222222222222'),
  0, 'Kullanıcı A, Kullanıcı B portföyünü okuyamaz');

select is(
  (select count(*)::int from public.transactions where user_id = '22222222-2222-2222-2222-222222222222'),
  0, 'Kullanıcı A, Kullanıcı B işlemlerini okuyamaz');

-- Doğrudan yazma: GRANT katmanı reddeder (mesaj "permission denied for table").
select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', 5000)$$,
  '42501',
  'permission denied for table transactions',
  'Kullanıcı A KENDİ portföyüne bile Data API ile doğrudan işlem ekleyemez (GRANT katmanı)'
);

select throws_ok(
  $$update public.transactions set quantity = 999
    where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table transactions',
  'Kullanıcı A kendi işlemini doğrudan güncelleyemez (GRANT katmanı)'
);

select throws_ok(
  $$delete from public.transactions where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table transactions',
  'Kullanıcı A kendi işlemini doğrudan silemez (GRANT katmanı)'
);

select throws_ok(
  $$update public.portfolios set name = 'ele geçirildi'
    where user_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table portfolios',
  'Kullanıcı A portföy adını doğrudan değiştiremez (GRANT katmanı)'
);

select throws_ok(
  $$update public.profiles set display_name = 'Yeni Ad'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table profiles',
  'Profil istemci için salt okunurdur: görünen ad bile doğrudan değiştirilemez'
);

select throws_ok(
  $$update public.profiles set role = 'admin'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table profiles',
  'Kullanıcı A kendi rolünü admin yapamaz (GRANT katmanı, tetikleyiciye gelmeden)'
);

select throws_ok(
  $$insert into public.user_preferences (user_id) values ('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  'permission denied for table user_preferences',
  'Kullanıcı A tercih kaydını doğrudan yazamaz (GRANT katmanı)'
);

-- RPC yüzeyi: authenticated JWT ile hiçbir kritik fonksiyon çağrılamaz.
select throws_ok(
  $$select public.create_transaction_checked(
      '11111111-1111-1111-1111-111111111111', 'gram-altin', 'buy', 1, 'gram',
      '2026-02-01', 5000, 0, '')$$,
  '42501',
  'permission denied for function create_transaction_checked',
  'authenticated create_transaction_checked RPC''sini çağıramaz'
);

select throws_ok(
  $$select public.lock_user_portfolio('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  'permission denied for function lock_user_portfolio',
  'authenticated dahili lock_user_portfolio yardımcısını çağıramaz'
);

select throws_ok(
  $$select public.login_rate_limit_check('x', 5, 60000, 60000, 60000)$$,
  '42501',
  'permission denied for function login_rate_limit_check',
  'authenticated hız sınırı RPC''sini çağıramaz'
);

select throws_ok(
  $$select public.purge_expired_sessions()$$,
  '42501',
  'permission denied for function purge_expired_sessions',
  'authenticated oturum temizliği RPC''sini çağıramaz'
);

select throws_ok(
  $$select * from public.provision_missing_defaults()$$,
  '42501',
  'permission denied for function provision_missing_defaults',
  'authenticated yönetici onarım RPC''sini çağıramaz'
);

select throws_ok(
  $$select count(*) from public.app_sessions$$,
  '42501',
  'permission denied for table app_sessions',
  'Normal kullanıcı oturum tablosunu OKUYAMAZ bile (GRANT katmanı)'
);

select throws_ok(
  $$select count(*) from public.login_rate_limits$$,
  '42501',
  'permission denied for table login_rate_limits',
  'Normal kullanıcı hız sınırı tablosunu okuyamaz (GRANT katmanı)'
);

select is((select count(*)::int from public.admin_audit_logs), 0,
  'Normal kullanıcı denetim kayıtlarını okuyamaz (SELECT grant var, RLS yalnızca admin''e açar)');

select ok((select count(*) from public.gold_products) > 0,
  'Kullanıcı A ürün kataloğunu okuyabilir');

-- =============================================================================
-- 5. POLİTİKA ENVANTERİ
-- =============================================================================

select tests.become_service();

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public'
     and policyname in ('portfolios_insert_own', 'portfolios_update_own', 'portfolios_delete_own',
                        'transactions_insert_own', 'transactions_update_own', 'transactions_delete_own',
                        'user_preferences_all_own', 'profiles_update_self')),
  0,
  '0002''deki doğrudan yazma politikaları kaldırılmıştır'
);

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public'
     and policyname in ('profiles_select_self_or_admin', 'portfolios_select_own',
                        'transactions_select_own', 'user_preferences_select_own',
                        'admin_audit_logs_select_admin', 'gold_products_select',
                        'price_sources_select', 'current_prices_select')),
  8,
  'SELECT politikaları korunmuştur (ikinci katman)'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and cmd <> 'SELECT'),
  0,
  'public şemasında SELECT dışında hiçbir RLS politikası yoktur'
);

-- =============================================================================
-- 6. YÖNETİCİ — authenticated JWT, rol admin
-- =============================================================================

select tests.authenticate_as('33333333-3333-3333-3333-333333333333');

select is((select count(*)::int from public.profiles), 4,
  'Yönetici tüm profilleri okuyabilir');

select ok((select count(*)::int from public.transactions) >= 2,
  'Yönetici kullanıcıların işlemlerini okuyabilir');

select throws_ok(
  $$update public.transactions set quantity = 123
    where user_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table transactions',
  'Yönetici bile Data API ile finansal kaydı düzenleyemez (GRANT katmanı)'
);

select ok((select count(*) from public.admin_audit_logs) >= 1,
  'Yönetici denetim kayıtlarını okuyabilir');

select throws_ok(
  $$insert into public.admin_audit_logs (admin_user_id, admin_username, action, success)
    values ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'user.view', true)$$,
  '42501',
  'permission denied for table admin_audit_logs',
  'Yönetici denetim kaydını doğrudan YAZAMAZ; yalnızca BFF yazar'
);

select throws_ok(
  $$select count(*) from public.app_sessions$$,
  '42501',
  'permission denied for table app_sessions',
  'Yönetici bile oturum tablosunu okuyamaz'
);

-- =============================================================================
-- 7. ANON
-- =============================================================================

select tests.become_anon();

select throws_ok(
  $$select count(*) from public.transactions$$,
  '42501',
  'permission denied for table transactions',
  'Oturumsuz istemci finansal tabloları okuyamaz (GRANT katmanı)'
);

select throws_ok(
  $$select count(*) from public.profiles$$,
  '42501',
  'permission denied for table profiles',
  'Oturumsuz istemci profilleri okuyamaz'
);

select throws_ok(
  $$select count(*) from public.gold_products$$,
  '42501',
  'permission denied for table gold_products',
  'Oturumsuz istemci kataloğu bile okuyamaz (istemci doğrudan sorgulamaz)'
);

select throws_ok(
  $$select public.is_admin()$$,
  '42501',
  'permission denied for function is_admin',
  'Oturumsuz istemci RLS yardımcılarını çağıramaz'
);

-- =============================================================================
-- 8. SAHİP BAĞLAMI (BFF / service_role: RLS atlanır) — bütünlük kısıtları
-- =============================================================================

select tests.become_service();

select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '22222222-2222-2222-2222-222222222222'),
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', 5000)$$,
  '23503',
  NULL,
  'Sahip bağlamında bile başka kullanıcının portföyüne işlem yazılamaz (composite FK, 23503)'
);

select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'gram-altin', 'buy', 1, 'adet', '2026-02-01', 5000)$$,
  '23514',
  NULL,
  'Katalogla uyuşmayan birim tetikleyiciyle reddedilir (23514)'
);

select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'olmayan-urun', 'buy', 1, 'gram', '2026-02-01', 5000)$$,
  '23514',
  NULL,
  'Katalogda olmayan ürün tetikleyiciyle reddedilir'
);

select throws_ok(
  $$select public.create_transaction_checked(
      '11111111-1111-1111-1111-111111111111', 'gram-altin', 'sell', 999, 'gram',
      '2026-02-01', 5000, 0, '')$$,
  'P0001',
  NULL,
  'Aşırı satış atomik RPC içinde reddedilir (ALTIN_OVERSELL, P0001)'
);

select lives_ok(
  $$select public.create_transaction_checked(
      '11111111-1111-1111-1111-111111111111', 'gram-altin', 'sell', 2, 'gram',
      '2026-02-01', 5000, 0, '')$$,
  'Eldeki miktarı aşmayan satış atomik RPC ile kaydedilir'
);

select is(
  (select count(*)::int from public.transactions where user_id = '11111111-1111-1111-1111-111111111111'),
  2,
  'RPC ile yazılan işlem tabloya ulaşır'
);

select lives_ok(
  $$select public.create_transaction_checked(
      '44444444-4444-4444-4444-444444444444', 'gram-altin', 'buy', 1, 'gram',
      '2026-02-01', 5000, 0, '')$$,
  'Onarılmış (provision_missing_defaults) kullanıcı için RPC işlem yazabilir'
);

select throws_ok(
  $$update public.admin_audit_logs set success = false$$,
  '42501',
  'Denetim kayıtları değiştirilemez ve silinemez.',
  'Denetim kaydı sahip bağlamında bile güncellenemez (tetikleyici)'
);

select throws_ok(
  $$delete from public.admin_audit_logs$$,
  '42501',
  'Denetim kayıtları değiştirilemez ve silinemez.',
  'Denetim kaydı sahip bağlamında bile silinemez (tetikleyici)'
);

-- =============================================================================
-- 9. KALICI OTURUM ŞEMASI (0007)
-- =============================================================================

select ok(
  (select bool_and(exists (
     select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_sessions' and column_name = c))
   from unnest(array['renewed_at', 'rotated_at', 'previous_token_hash',
                     'previous_token_valid_until', 'device_label']) as c),
  'app_sessions kalıcı oturum sütunlarını taşır'
);

select col_is_null('public', 'app_sessions', 'device_mode',
  'device_mode artık zorunlu değildir (deprecated, yalnızca eski veri)');

select is(
  (select count(*)::int from pg_constraint
   where conname in ('app_sessions_shared_needs_idle', 'app_sessions_device_mode_check')),
  0,
  'Cihaz moduna bağlı kısıtlar kaldırılmıştır'
);

select is(
  (select device_mode from public.app_sessions where id = 'dddddddd-0000-0000-0000-000000000001'),
  NULL,
  'Yeni oturum kaydı device_mode kullanmaz'
);

-- Temizlik: iptal edilmiş + süresi dolmuş silinir, aktif kalır.
insert into public.app_sessions (id, user_id, token_hash, expires_at, absolute_expires_at, revoked_at)
values ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'iptal-edilen', now() + interval '10 days', now() + interval '10 days', now());
insert into public.app_sessions (id, user_id, token_hash, expires_at, absolute_expires_at)
values ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
        'suresi-dolan', now() - interval '1 day', now() - interval '1 day');

select is(public.purge_expired_sessions(), 2,
  'purge_expired_sessions yalnızca iptal edilmiş ve süresi dolmuş oturumları siler');

select is(
  (select count(*)::int from public.app_sessions where id = 'dddddddd-0000-0000-0000-000000000001'),
  1,
  'Aktif kalıcı oturum temizlikten etkilenmez'
);

select is(
  (select count(*)::int from public.app_sessions
   where id = 'dddddddd-0000-0000-0000-000000000001'
     and last_seen_at is not null and idle_expires_at is null),
  1,
  'Aktif oturumda hareketsizlik alanı kullanılmaz (null)'
);

select * from finish();

rollback;
