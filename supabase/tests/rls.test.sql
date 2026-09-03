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

select plan(272);

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
grant usage on schema tests to anon, authenticated, service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;

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

-- Test işlemleri: kaynak gerçek DEFTERDİR; kayıtlar RPC üzerinden yazılır.
do $$
begin
  perform public.create_transaction_checked('11111111-1111-1111-1111-111111111111',
    'gram-altin', 'buy', 10, 'gram', '2026-01-10', 5000, 0, '');
  perform public.create_transaction_checked('22222222-2222-2222-2222-222222222222',
    'gram-altin', 'buy', 4, 'gram', '2026-01-11', 5100, 0, '');
end;
$$;

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
     'public.profiles', 'public.portfolios', 'public.user_preferences',
     'public.app_sessions', 'public.login_rate_limits'
   ]) as t),
  'service_role (BFF) kişisel/oturum tablolarında tam yetkilidir'
);

select ok(
  has_table_privilege('service_role', 'public.transactions', 'SELECT')
  and not has_table_privilege('service_role', 'public.transactions', 'INSERT')
  and not has_table_privilege('service_role', 'public.transactions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.transactions', 'DELETE'),
  'transactions: service_role yalnızca SELECT; finansal yazma yalnızca defter RPC''leri ile (0011)'
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
  $$select public.ledger_append('11111111-1111-1111-1111-111111111111', '{}'::jsonb)$$,
  '42501',
  'permission denied for function ledger_append',
  'authenticated defter RPC''sini (ledger_append) çağıramaz'
);

select throws_ok(
  $$select public.ledger_void('11111111-1111-1111-1111-111111111111', gen_random_uuid(), 'x')$$,
  '42501',
  'permission denied for function ledger_void',
  'authenticated defter RPC''sini (ledger_void) çağıramaz'
);

select is((select count(*)::int from public.portfolio_positions), 1,
  'Kullanıcı A yalnızca kendi pozisyonunu görür (RLS)');

select is(
  (select count(*)::int from public.portfolio_positions where user_id = '22222222-2222-2222-2222-222222222222'),
  0, 'Kullanıcı A, Kullanıcı B pozisyonunu göremez');

select throws_ok(
  $$insert into public.portfolio_positions (portfolio_id, user_id, product_id, quantity)
    values ((select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            '11111111-1111-1111-1111-111111111111', 'gram-altin', 999)$$,
  '42501',
  'permission denied for table portfolio_positions',
  'Kullanıcı A türetilmiş pozisyonu doğrudan yazamaz (GRANT katmanı)'
);

select throws_ok(
  $$insert into public.price_snapshots (user_id, product_id, liquidation_price, replacement_price, provider, market, provider_status, provider_timestamp, fetched_at)
    values ('11111111-1111-1111-1111-111111111111', 'gram-altin', 1, 1, 'x', 'x', 'ok', now(), now())$$,
  '42501',
  'permission denied for table price_snapshots',
  'Kullanıcı A fiyat anlık görüntüsünü doğrudan yazamaz (GRANT katmanı)'
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
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, occurred_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '22222222-2222-2222-2222-222222222222'),
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', '2026-01-31 21:00:00+00', 5000)$$,
  '23503',
  NULL,
  'Sahip bağlamında bile başka kullanıcının portföyüne işlem yazılamaz (composite FK, 23503)'
);

select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, occurred_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'gram-altin', 'buy', 1, 'adet', '2026-02-01', '2026-01-31 21:00:00+00', 5000)$$,
  '23514',
  NULL,
  'Katalogla uyuşmayan birim tetikleyiciyle reddedilir (23514)'
);

select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, occurred_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'olmayan-urun', 'buy', 1, 'gram', '2026-02-01', '2026-01-31 21:00:00+00', 5000)$$,
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


-- =============================================================================
-- 10. OTURUM POLİTİKASI (0008)
-- =============================================================================

select tests.become_service();

select col_default_is('public', 'app_sessions', 'persistent', 'true',
  'persistent varsayılanı true: mevcut kullanıcı oturumları kalıcı tercih verilmiş sayılır');

select is(
  (select persistent from public.app_sessions where id = 'dddddddd-0000-0000-0000-000000000001'),
  true,
  'Kurulumdaki (eski biçim) oturum kalıcı sayılır; geçersiz kılınmaz'
);

insert into public.app_sessions (id, user_id, token_hash, persistent, expires_at, absolute_expires_at, idle_expires_at)
values ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
        'hareketsiz-dolan', false, now() + interval '7 hours', now() + interval '7 hours', now() - interval '1 minute');

select is(public.purge_expired_sessions(), 1,
  'Hareketsizliği dolan tarayıcı oturumu bakım temizliğiyle silinir');

-- =============================================================================
-- 11. MUHASEBE: YETKİLER (0009 / 0010)
-- =============================================================================

select ok(
  (select bool_and(
     has_function_privilege('service_role', f, 'execute')
     and not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.ledger_append(uuid, jsonb)',
     'public.ledger_void(uuid, uuid, text)',
     'public.ledger_replace(uuid, uuid, jsonb)',
     'public.ledger_void_all(uuid, text)',
     'public.ledger_list(uuid)',
     'public.positions_list(uuid)',
     'public.ledger_verify(uuid)',
     'public.ledger_revision(uuid)'
   ]) as f),
  'Defter RPC''leri (sürüm dâhil) yalnızca service_role tarafından çağrılabilir'
);

select ok(
  (select bool_and(
     not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute')
     and not has_function_privilege('service_role', f, 'execute'))
   from unnest(array[
     'public.ledger_compute_amounts(text, text, numeric, numeric, numeric, numeric, numeric, numeric)',
     'public.ledger_replay_product(uuid, text)',
     'public.ledger_rebuild_position(uuid, text)',
     'public.ledger_transaction_json(public.transactions)',
     'public.guard_ledger_mutation()',
     'public.reject_snapshot_mutation()',
     'public.ledger_bump_revision(uuid)',
     'public.guard_portfolio_revision()',
     'public.ledger_parse_numeric(text, text)',
     'public.ledger_parse_uuid(text, text)'
   ]) as f),
  'Muhasebe yardımcıları ve tetikleyici fonksiyonları hiçbir role açık değildir'
);

select ok(
  has_table_privilege('authenticated', 'public.price_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'public.price_snapshots', 'INSERT')
  and not has_table_privilege('anon', 'public.price_snapshots', 'SELECT')
  and has_table_privilege('service_role', 'public.price_snapshots', 'SELECT')
  and not has_table_privilege('service_role', 'public.price_snapshots', 'INSERT')
  and not has_table_privilege('service_role', 'public.price_snapshots', 'UPDATE')
  and not has_table_privilege('service_role', 'public.price_snapshots', 'DELETE'),
  'price_snapshots: authenticated/service_role yalnızca SELECT; INSERT yalnızca RPC (sahip), UPDATE/DELETE kimseye'
);

select ok(
  has_table_privilege('authenticated', 'public.portfolio_positions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.portfolio_positions', 'INSERT')
  and has_table_privilege('service_role', 'public.portfolio_positions', 'SELECT')
  and not has_table_privilege('service_role', 'public.portfolio_positions', 'INSERT')
  and not has_table_privilege('service_role', 'public.portfolio_positions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.portfolio_positions', 'DELETE'),
  'portfolio_positions türetilmiş projeksiyonuna service_role bile doğrudan yazamaz'
);

-- service_role gerçek rolüyle dener (BFF bağlamı)
select set_config('role', 'service_role', true);
select throws_ok(
  $$insert into public.portfolio_positions (portfolio_id, user_id, product_id, quantity)
    values ((select id from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444'),
            '44444444-4444-4444-4444-444444444444', 'gram-altin', 1)$$,
  '42501',
  'permission denied for table portfolio_positions',
  'service_role pozisyon tablosunu elle düzenleyemez; yalnızca RPC yeniden oluşturur'
);

-- Sprint 1.1: service_role DOĞRUDAN defter/snapshot yazamaz; yalnızca kontrollü RPC
select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, occurred_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            (select id from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', '2026-01-31 21:00:00+00', 5000)$$,
  '42501',
  'permission denied for table transactions',
  'service_role transactions tablosuna DOĞRUDAN INSERT yapamaz (0011)'
);

select throws_ok(
  $$update public.transactions set note = 'elle' where user_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table transactions',
  'service_role transactions tablosunu DOĞRUDAN UPDATE edemez (0011)'
);

select throws_ok(
  $$delete from public.transactions where user_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  'permission denied for table transactions',
  'service_role transactions tablosundan DOĞRUDAN DELETE edemez (0011)'
);

select throws_ok(
  $$insert into public.price_snapshots
      (user_id, product_id, liquidation_price, replacement_price, provider, market, provider_status,
       provider_timestamp, fetched_at)
    values ('11111111-1111-1111-1111-111111111111', 'gram-altin', 1, 1, 'elle', 'ELLE', 'ok', now(), now())$$,
  '42501',
  'permission denied for table price_snapshots',
  'service_role price_snapshots tablosuna DOĞRUDAN INSERT yapamaz (0011)'
);

select lives_ok(
  $$select public.ledger_append('11111111-1111-1111-1111-111111111111', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'gram-altin', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-02', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-service-role'))$$,
  'Aynı service_role ledger_append RPC ile yazabilir (kontrollü yol açık)'
);

select is(
  (public.ledger_verify('11111111-1111-1111-1111-111111111111')->'mismatches'),
  '[]'::jsonb,
  'RPC sonrası projeksiyon defterle eşleşir (service_role ledger_verify)'
);

select is(
  (select count(*)::int from public.transactions
   where user_id = '11111111-1111-1111-1111-111111111111' and client_request_id = 'req-pgtap-service-role'),
  1,
  'service_role''ün RPC ile yazdığı kayıt tabloya ulaşır; doğrudan yazma denemeleri iz bırakmaz'
);
select tests.become_service();

-- =============================================================================
-- 12. MUHASEBE: HESAPLAMA (kesin kabul örnekleri, Postgres motoru)
-- =============================================================================

create temp table if not exists tests_vars (key text primary key, value jsonb);

-- ÖRNEK 1 — Kullanıcı C: 5×3.500, 5×4.200, 5×3.700
do $$
declare
  c uuid := '44444444-4444-4444-4444-444444444444';
  base jsonb := jsonb_build_object('kind', 'BUY', 'product_id', 'kulce-ozel-gramaj', 'unit', 'gram',
    'pricing_input_mode', 'UNIT_PRICE', 'total_amount', null, 'fees', '0', 'workmanship', '0',
    'cost_basis_origin', 'ACTUAL', 'note', '', 'client_request_id', null);
begin
  perform public.ledger_append(c, base || jsonb_build_object('quantity', '5', 'occurred_at', '2026-01-10', 'unit_price', '3500'));
  perform public.ledger_append(c, base || jsonb_build_object('quantity', '5', 'occurred_at', '2026-01-11', 'unit_price', '4200'));
  perform public.ledger_append(c, base || jsonb_build_object('quantity', '5', 'occurred_at', '2026-01-12', 'unit_price', '3700'));
end;
$$;

select is(
  (select public.ledger_num_text(quantity) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '15', 'ÖRNEK 1: miktar 15 gram');

select is(
  (select public.ledger_num_text(remaining_cost_basis) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '57000', 'ÖRNEK 1: toplam maliyet 57.000');

select is(
  (select public.ledger_num_text(average_cost) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '3800', 'ÖRNEK 1: ortalama maliyet 3.800');

-- ÖRNEK 4 — satış 4 gram × 4.200
do $$
begin
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'kulce-ozel-gramaj', 'quantity', '4', 'unit', 'gram',
    'occurred_at', '2026-02-01', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '4200',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select public.ledger_num_text(net_proceeds) from public.transactions
   where user_id = '44444444-4444-4444-4444-444444444444' and transaction_kind = 'SELL'),
  '16800', 'ÖRNEK 4: net satış geliri 16.800');

select is(
  (select public.ledger_num_text(realized_pnl) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '1600', 'ÖRNEK 4: gerçekleşmiş K/Z 1.600 (çıkarılan maliyet 15.200)');

select is(
  (select public.ledger_num_text(quantity) || '|' || public.ledger_num_text(remaining_cost_basis) || '|' || public.ledger_num_text(average_cost)
   from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '11|41800|3800', 'ÖRNEK 4: kalan 11 gram, 41.800 TL; satış ortalamayı DEĞİŞTİRMEZ');

-- Aşırı satış: RPC reddeder, defter değişmez
select throws_ok(
  $$select public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'kulce-ozel-gramaj', 'quantity', '20', 'unit', 'gram',
    'occurred_at', '2026-02-02', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '4200',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0001', NULL,
  'Eldeki miktarı aşan satış ALTIN_OVERSELL ile reddedilir'
);

select is(
  (select count(*)::int from public.transactions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj' and status = 'ACTIVE'),
  4, 'Reddedilen satış deftere yazılmaz');

-- ÖRNEK 5 — masraflar (Kullanıcı B, has-altin)
do $$
begin
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'has-altin', 'quantity', '10', 'unit', 'gram',
    'occurred_at', '2026-01-15', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '100', 'workmanship', '500', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select public.ledger_num_text(total_paid) || '|' || public.ledger_num_text(quoted_acquisition_unit_price)
     || '|' || public.ledger_num_text(effective_acquisition_unit_cost) || '|' || public.ledger_num_text(gross_amount)
   from public.transactions where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'has-altin'),
  '50600|5000|5060|50000',
  'ÖRNEK 5: girilen birim fiyat 5.000 KORUNUR; total 50.600; masraflar dâhil efektif 5.060; brüt 50.000');

select is(
  (select public.ledger_num_text(average_cost) from public.portfolio_positions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'has-altin'),
  '5060', 'ÖRNEK 5: pozisyon ortalama maliyeti total_paid üzerinden 5.060');

-- ÖRNEK 6 — toplam ödenen modu (Kullanıcı B, kulce-24-ayar)
do $$
begin
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'kulce-24-ayar', 'quantity', '10', 'unit', 'gram',
    'occurred_at', '2026-01-16', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '51200', 'fees', '0', 'workmanship', '300', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select public.ledger_num_text(total_paid) || '|' || coalesce(public.ledger_num_text(quoted_acquisition_unit_price), 'null')
     || '|' || public.ledger_num_text(effective_acquisition_unit_cost) || '|' || public.ledger_num_text(gross_amount)
   from public.transactions where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'kulce-24-ayar'),
  '51200|null|5120|50900',
  'ÖRNEK 6: toplam ödenen modunda girilen birim fiyat UYDURULMAZ (null); efektif 5.120; işçilik ikinci kez eklenmez');

-- ÖRNEK 10 — decimal hassasiyeti (Kullanıcı B, altin-18-ayar)
do $$
declare
  base jsonb := jsonb_build_object('kind', 'BUY', 'product_id', 'altin-18-ayar', 'unit', 'gram',
    'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000.33', 'total_amount', null,
    'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL', 'note', '', 'client_request_id', null);
begin
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', base || jsonb_build_object('quantity', '0.1', 'occurred_at', '2026-01-17'));
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', base || jsonb_build_object('quantity', '0.2', 'occurred_at', '2026-01-18'));
end;
$$;

select is(
  (select public.ledger_num_text(quantity) || '|' || public.ledger_num_text(remaining_cost_basis)
   from public.portfolio_positions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'altin-18-ayar'),
  '0.3|1500.099', 'ÖRNEK 10: 0,1 + 0,2 = 0,3 gram; kayan nokta artığı yok');

-- ÖRNEK 8 — idempotency
do $$
declare
  payload jsonb := jsonb_build_object('kind', 'BUY', 'product_id', 'kulce-ozel-gramaj', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-03', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-000001');
begin
  insert into tests_vars values ('idem1', public.ledger_append('44444444-4444-4444-4444-444444444444', payload));
  insert into tests_vars values ('idem2', public.ledger_append('44444444-4444-4444-4444-444444444444', payload));
end;
$$;

select is(((select value from tests_vars where key = 'idem2')->>'replayed')::boolean, true,
  'ÖRNEK 8: aynı istek kimliğiyle ikinci gönderim replay döner');

select is(
  (select value->'transaction'->>'id' from tests_vars where key = 'idem1'),
  (select value->'transaction'->>'id' from tests_vars where key = 'idem2'),
  'ÖRNEK 8: ikinci yanıt ilk işlemin kimliğini döner; tek kayıt oluşur');

select is(
  (select count(*)::int from public.transactions
   where user_id = '44444444-4444-4444-4444-444444444444' and client_request_id = 'req-pgtap-000001'),
  1, 'ÖRNEK 8: miktar bir kez artar');

select throws_ok(
  $$select public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'kulce-ozel-gramaj', 'quantity', '2', 'unit', 'gram',
    'occurred_at', '2026-02-03', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-000001'))$$,
  'P0003', NULL,
  'ÖRNEK 8: aynı istek kimliği farklı içerikle gelirse conflict'
);

-- VOID: iptal hard delete değildir
do $$
declare
  target uuid := (select (value->'transaction'->>'id')::uuid from tests_vars where key = 'idem1');
begin
  insert into tests_vars values ('void1', public.ledger_void('44444444-4444-4444-4444-444444444444', target, 'pgTAP iptal'));
end;
$$;

select is(
  (select status || '|' || void_reason from public.transactions
   where client_request_id = 'req-pgtap-000001'),
  'VOID|pgTAP iptal', 'İptal edilen kayıt VOID durumuna geçer, sebep saklanır, satır silinmez');

select is(
  (select public.ledger_num_text(quantity) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '11', 'İptal sonrası pozisyon yeniden hesaplanır');

select throws_ok(
  $$select public.ledger_void('44444444-4444-4444-4444-444444444444',
      (select id from public.transactions where client_request_id = 'req-pgtap-000001'), 'tekrar')$$,
  'P0005', NULL,
  'İptal edilmiş kayıt yeniden iptal edilemez'
);

-- ÖRNEK 9 — geçmiş alışın iptali sonraki satışı negatife düşürüyorsa reddedilir
do $$
begin
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'kulce-ozel-gramaj', 'quantity', '9', 'unit', 'gram',
    'occurred_at', '2026-02-04', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '37800', 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-sell-9'));
end;
$$;

select throws_ok(
  $$select public.ledger_void('44444444-4444-4444-4444-444444444444',
      (select id from public.transactions where user_id = '44444444-4444-4444-4444-444444444444'
         and transaction_kind = 'BUY' and traded_at = '2026-01-10' and status = 'ACTIVE'), 'geçmiş')$$,
  'P0001', NULL,
  'ÖRNEK 9: geçmiş alışın iptali sonraki satışı aşırıya düşürürse reddedilir'
);

select is(
  (select status from public.transactions where user_id = '44444444-4444-4444-4444-444444444444'
     and transaction_kind = 'BUY' and traded_at = '2026-01-10'),
  'ACTIVE', 'ÖRNEK 9: reddedilen iptal defteri değiştirmez');

-- REPLACE: 9 gramlık satış 8 gram olarak düzeltilir (tek işlem, ilişki korunur)
do $$
declare
  old_id uuid := (select id from public.transactions where client_request_id = 'req-pgtap-sell-9');
begin
  insert into tests_vars values ('replace1', public.ledger_replace('44444444-4444-4444-4444-444444444444', old_id,
    jsonb_build_object('kind', 'SELL', 'product_id', 'kulce-ozel-gramaj', 'quantity', '8', 'unit', 'gram',
      'occurred_at', '2026-02-04', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '4200',
      'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
      'note', 'düzeltme', 'client_request_id', 'req-pgtap-replace-1')));
end;
$$;

select is(
  (select status from public.transactions where client_request_id = 'req-pgtap-sell-9'),
  'REPLACED', 'Düzeltilen kayıt REPLACED olur; silinmez');

select is(
  (select t.replaced_by_transaction_id from public.transactions t where t.client_request_id = 'req-pgtap-sell-9'),
  (select id from public.transactions where client_request_id = 'req-pgtap-replace-1'),
  'Eski kayıt yeni kayda, yeni kayıt eski kayda bağlanır');

select is(
  (select replaces_transaction_id from public.transactions where client_request_id = 'req-pgtap-replace-1'),
  (select id from public.transactions where client_request_id = 'req-pgtap-sell-9'),
  'Yeni kayıt neyi düzelttiğini taşır');

select is(
  (select public.ledger_num_text(quantity) from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'kulce-ozel-gramaj'),
  '3', 'Düzeltme sonrası pozisyon: 15 − 4 − 8 = 3 gram');

-- Defter koruması: finansal alan güncellenemez, satır silinemez (sahip bağlamında bile)
select throws_ok(
  $$update public.transactions set quantity = 1 where client_request_id = 'req-pgtap-replace-1'$$,
  '42501', NULL,
  'Defter kaydının finansal alanı sahip bağlamında bile güncellenemez (tetikleyici)'
);

select throws_ok(
  $$delete from public.transactions where client_request_id = 'req-pgtap-replace-1'$$,
  '42501', NULL,
  'Defter kaydı hard delete edilemez (tetikleyici)'
);

-- MARKET_BASELINE: sunucu anlık görüntüsü aynı işlemde saklanır ve değiştirilemez
do $$
begin
  insert into tests_vars values ('baseline1', public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'yeni-ceyrek', 'quantity', '2', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now()))));
end;
$$;

select is(
  (select value->'transaction'->>'totalPaid' from tests_vars where key = 'baseline1'),
  '22000', 'MARKET_BASELINE: başlangıç maliyet bazı = miktar × bozdurma fiyatı');

select is(
  (select value->'transaction'->'priceSnapshot'->>'liquidationPrice' from tests_vars where key = 'baseline1'),
  '11000', 'MARKET_BASELINE: anlık görüntü kayıtla birlikte döner');

select is(
  (select has_baseline from public.portfolio_positions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'yeni-ceyrek'),
  true, 'MARKET_BASELINE: pozisyon "takip başlangıç değeri" olarak işaretlenir');

select throws_ok(
  $$update public.price_snapshots set liquidation_price = 1$$,
  '42501', NULL,
  'Fiyat anlık görüntüsü sonradan değiştirilemez'
);

select throws_ok(
  $$delete from public.price_snapshots$$,
  '42501', NULL,
  'Fiyat anlık görüntüsü silinemez'
);

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'yeni-ceyrek', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'stale',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now())))$$,
  'P0004', NULL,
  'Bayat/kullanılamaz fiyatla MARKET_BASELINE oluşturulamaz'
);

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'yeni-ceyrek', 'quantity', '1.5', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '11000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  '23514', NULL,
  'Adet ürününe ondalık miktar girilemez (tetikleyici)'
);

-- Doğrulama: defter ↔ türetilmiş pozisyon
select is(
  (public.ledger_verify('44444444-4444-4444-4444-444444444444')->'mismatches'),
  '[]'::jsonb, 'ledger_verify: Kullanıcı C için tutarsızlık yok');

select is(
  (public.ledger_verify('22222222-2222-2222-2222-222222222222')->'mismatches'),
  '[]'::jsonb, 'ledger_verify: Kullanıcı B için tutarsızlık yok');

select is(
  (select p->>'averageCost' from jsonb_array_elements(public.positions_list('44444444-4444-4444-4444-444444444444')) p
   where p->>'productId' = 'kulce-ozel-gramaj'),
  '3800', 'positions_list: sayılar kanonik ondalık METİN olarak döner');

select ok(
  (select jsonb_array_length(public.ledger_list('44444444-4444-4444-4444-444444444444')) >= 7),
  'ledger_list: VOID ve REPLACED kayıtlar dâhil tüm defter döner');

-- =============================================================================
-- 13. MUHASEBE BÜTÜNLÜĞÜ (0011): köken ayrımı, tarih/saat sırası, anlık görüntü kısıtları
-- =============================================================================

-- Tarih-only kayıt Europe/Istanbul günün başlangıcıdır (UTC 21:00 önceki gün)
select is(
  (select occurred_at from public.transactions
   where user_id = '44444444-4444-4444-4444-444444444444' and traded_at = '2026-01-10' and transaction_kind = 'BUY'
   order by ledger_sequence limit 1),
  '2026-01-09 21:00:00+00'::timestamptz,
  'Saat girilmeyen kayıt: occurred_at = tarih 00:00 Europe/Istanbul (traded_at ile tutarlı)');

-- Takvimde olmayan tarih ve artık yıl
select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-30', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  '2026-02-30 gibi takvimde olmayan tarih açık hatayla (P0004) reddedilir; genel 500 üretmez');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2023-02-29', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  '2023-02-29 (artık yıl değil) reddedilir');

select lives_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2024-02-29', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  '2024-02-29 (artık yıl) kabul edilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', to_char((now() at time zone 'Europe/Istanbul')::date + 1, 'YYYY-MM-DD'),
    'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Gelecek tarih reddedilir');

-- Aynı gün gerçek sıra: 10:00 alış, 11:00 satış geçer; 09:00 satış aşırı satıştır
do $$
begin
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-14-ayar', 'quantity', '2', 'unit', 'gram',
    'occurred_at', '2026-02-10', 'occurred_time', '10:00', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'altin-14-ayar', 'quantity', '2', 'unit', 'gram',
    'occurred_at', '2026-02-10', 'occurred_time', '11:00', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3100',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select to_char(occurred_time, 'HH24:MI') || '|' || to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
   from public.transactions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'altin-14-ayar' and transaction_kind = 'BUY'),
  '10:00|2026-02-10 07:00',
  'Saat Europe/Istanbul yerel saati olarak saklanır; occurred_at UTC karşılığıdır (10:00 → 07:00Z)');

select is(
  (select public.ledger_num_text(quantity) || '|' || has_actual::text || '|' || realized_has_actual::text
   from public.portfolio_positions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'altin-14-ayar'),
  '0|false|true',
  'Aynı gün 10:00 alış + 11:00 satış geçer; tam kapanan pozisyonda holding kökeni yok, realized köken korunur');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'altin-14-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-10', 'occurred_time', '09:00', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3100',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0001', NULL,
  'Aynı gün alıştan ÖNCEKİ saate satış kronolojik sırayla aşırı satıştır (P0001)');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-14-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-10', 'occurred_time', '25:00', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Geçersiz saat (25:00) reddedilir');

-- Tarih/saat değişikliği aşırı satış oluşturuyorsa düzeltme reddedilir
select throws_ok(
  $$select public.ledger_replace('22222222-2222-2222-2222-222222222222',
      (select id from public.transactions where user_id = '22222222-2222-2222-2222-222222222222'
         and product_id = 'altin-14-ayar' and transaction_kind = 'BUY' and status = 'ACTIVE'),
      jsonb_build_object(
        'kind', 'BUY', 'product_id', 'altin-14-ayar', 'quantity', '2', 'unit', 'gram',
        'occurred_at', '2026-02-10', 'occurred_time', '12:00', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
        'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
        'note', '', 'client_request_id', null))$$,
  'P0001', NULL,
  'Alışın saati satışın sonrasına çekilirse düzeltme aşırı satış nedeniyle reddedilir');

select is(
  (select status from public.transactions
   where user_id = '22222222-2222-2222-2222-222222222222' and product_id = 'altin-14-ayar' and transaction_kind = 'BUY'),
  'ACTIVE', 'Reddedilen düzeltme defteri değiştirmez');

-- Guard: occurred_at / occurred_time değiştirilemez
select throws_ok(
  $$update public.transactions set occurred_time = '10:30' where product_id = 'altin-14-ayar'$$,
  '42501', NULL,
  'İşlem saati sahip bağlamında bile güncellenemez (tetikleyici)');

-- Köken ayrımı: baseline ile aç → tamamını sat → ACTUAL ile yeniden aç (Kullanıcı C, cumhuriyet-altini)
do $$
begin
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'cumhuriyet-altini', 'quantity', '10', 'unit', 'adet',
    'occurred_at', '2026-02-01', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('product_id', 'cumhuriyet-altini',
      'liquidation_price', '38000', 'replacement_price', '39000',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now())));
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'cumhuriyet-altini', 'quantity', '10', 'unit', 'adet',
    'occurred_at', '2026-02-02', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '39000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select public.ledger_num_text(quantity) || '|' || public.ledger_num_text(remaining_cost_basis) || '|'
     || coalesce(public.ledger_num_text(average_cost), 'null') || '|' || has_baseline::text || '|' || realized_has_baseline::text
     || '|' || public.ledger_num_text(realized_pnl)
   from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'cumhuriyet-altini'),
  '0|0|null|false|true|10000',
  'Tam kapanmış baseline pozisyon: miktar 0, maliyet 0, ortalama null, holding baseline=false, realized baseline korunur');

do $$
begin
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'cumhuriyet-altini', 'quantity', '5', 'unit', 'adet',
    'occurred_at', '2026-02-03', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '38500',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null));
end;
$$;

select is(
  (select public.ledger_num_text(quantity) || '|' || public.ledger_num_text(average_cost) || '|'
     || has_actual::text || '|' || has_estimated::text || '|' || has_baseline::text || '|'
     || realized_has_actual::text || '|' || realized_has_baseline::text
   from public.portfolio_positions
   where user_id = '44444444-4444-4444-4444-444444444444' and product_id = 'cumhuriyet-altini'),
  '5|38500|true|false|false|false|true',
  'ACTUAL ile yeniden açılan pozisyonun kalitesi ACTUAL; tarihsel realized köken MARKET_BASELINE kalır');

select is(
  (select p->'holdingCostOrigins'->>'actual' || '|' || (p->'holdingCostOrigins'->>'baseline') || '|' || (p->'realizedPnlOrigins'->>'baseline')
   from jsonb_array_elements(public.positions_list('44444444-4444-4444-4444-444444444444')) p
   where p->>'productId' = 'cumhuriyet-altini'),
  'true|false|true',
  'positions_list iki köken kümesini ayrı döner (holdingCostOrigins / realizedPnlOrigins)');

select is(
  (public.ledger_verify('44444444-4444-4444-4444-444444444444')->'mismatches'),
  '[]'::jsonb, 'ledger_verify köken bayraklarını da karşılaştırır; tutarsızlık yok');

-- Anlık görüntü doğrulaması (RPC) ve kısıtı (tablo)
select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'ata-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '10000',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now())))$$,
  'P0004', NULL,
  'Ters makas (replacement < liquidation) ile MARKET_BASELINE oluşturulamaz');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'ata-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now() + interval '1 hour', 'fetched_at', now())))$$,
  'P0004', NULL,
  'Gelecek zaman damgalı anlık görüntü reddedilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'ata-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now() - interval '1 hour', 'fetched_at', now() - interval '1 hour')))$$,
  'P0004', NULL,
  'Bayat (15 dakikadan eski) anlık görüntü reddedilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'ata-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('product_id', 'gram-altin', 'liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now())))$$,
  'P0004', NULL,
  'Başka ürüne ait anlık görüntü reddedilir (sessiz ikame yok)');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'ata-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-05', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'USD', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now(), 'fetched_at', now())))$$,
  'P0004', NULL,
  'TL dışı para birimi reddedilir');

select throws_ok(
  $$insert into public.price_snapshots
      (user_id, product_id, liquidation_price, replacement_price, provider, market, provider_status,
       provider_timestamp, fetched_at)
    values ('22222222-2222-2222-2222-222222222222', 'ata-altin', 11000, 10000, 'mock', 'TEST', 'ok', now(), now())$$,
  '23514', NULL,
  'Tablo kısıtı: ters makaslı anlık görüntü sahip bağlamında bile yazılamaz (23514)');

select is(
  (select count(*)::int from public.price_snapshots where product_id = 'ata-altin'),
  0, 'Reddedilen anlık görüntüler tabloya yazılmaz');

-- =============================================================================
-- 14. SPRINT 2: defter sürümü, sayısal sınırlar, replay biçimi, hesap silme cascade
-- =============================================================================

-- Sürüm: Kullanıcı C'nin defteri değişti → sürüm > 0; replay ve başarısız işlem artırmaz
select ok(
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444') > 0,
  'Gerçek defter değişiklikleri sürümü artırmıştır');

select is(
  (public.ledger_revision('44444444-4444-4444-4444-444444444444')->>'revision')::bigint,
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444'),
  'ledger_revision RPC portföydeki sürümü döner');

insert into tests_vars values ('rev_before', to_jsonb((select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444')));

do $$
begin
  -- Aynı istek kimliği (req-pgtap-000001 VOID edildi ama replay yine döner): sürüm ARTMAZ
  perform public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'kulce-ozel-gramaj', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-03', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-000001'));
end;
$$;

select is(
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444'),
  (select (value)::bigint from tests_vars where key = 'rev_before'),
  'Idempotent replay sürümü artırmaz');

select throws_ok(
  $$select public.ledger_append('44444444-4444-4444-4444-444444444444', jsonb_build_object(
    'kind', 'SELL', 'product_id', 'kulce-ozel-gramaj', 'quantity', '999', 'unit', 'gram',
    'occurred_at', '2026-02-20', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '4200',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0001', NULL,
  'Başarısız işlem (aşırı satış) geri alınır');

select is(
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444'),
  (select (value)::bigint from tests_vars where key = 'rev_before'),
  'Başarısız işlem sürümü artırmaz');

select throws_ok(
  $$update public.portfolios set ledger_revision = ledger_revision + 100
    where user_id = '44444444-4444-4444-4444-444444444444'$$,
  '42501', NULL,
  'Defter sürümü sahip bağlamında bile elle değiştirilemez (tetikleyici)');

select lives_ok(
  $$update public.portfolios set name = 'Yeni ad' where user_id = '44444444-4444-4444-4444-444444444444'$$,
  'Portföy adı değişikliği sürüm alanına dokunmaz ve serbesttir');

do $$
begin
  perform public.ledger_void_all('44444444-4444-4444-4444-444444444444', 'temizlik');
end;
$$;

select ok(
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444')
    = (select (value)::bigint from tests_vars where key = 'rev_before') + 1,
  'ledger_void_all gerçek iptal yaptığında sürüm bir kez artar');

select is(
  public.ledger_void_all('44444444-4444-4444-4444-444444444444', 'bos'),
  0, 'İptal edilecek kayıt yoksa 0 döner');

select ok(
  (select ledger_revision from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444')
    = (select (value)::bigint from tests_vars where key = 'rev_before') + 1,
  'Boş ledger_void_all sürüm sinyali üretmez');

-- Replace replay biçimi: ürün değişince ilk yanıt ve replay [eski ürün, yeni ürün] döner
do $$
declare
  first_id uuid;
begin
  insert into tests_vars values ('rep_base', public.ledger_append('11111111-1111-1111-1111-111111111111', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'gram-altin', 'quantity', '2', 'unit', 'gram',
    'occurred_at', '2026-02-11', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null)));
  first_id := (select (value->'transaction'->>'id')::uuid from tests_vars where key = 'rep_base');
  insert into tests_vars values ('rep_first', public.ledger_replace('11111111-1111-1111-1111-111111111111', first_id,
    jsonb_build_object('kind', 'BUY', 'product_id', 'has-altin', 'quantity', '1', 'unit', 'gram',
      'occurred_at', '2026-02-11', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5100',
      'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
      'note', '', 'client_request_id', 'req-pgtap-replace-replay')));
  insert into tests_vars values ('rev_rep', to_jsonb((select ledger_revision from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111')));
  insert into tests_vars values ('rep_again', public.ledger_replace('11111111-1111-1111-1111-111111111111', first_id,
    jsonb_build_object('kind', 'BUY', 'product_id', 'has-altin', 'quantity', '1', 'unit', 'gram',
      'occurred_at', '2026-02-11', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '5100',
      'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
      'note', '', 'client_request_id', 'req-pgtap-replace-replay')));
end;
$$;

select is(
  (select jsonb_agg(p->>'productId') from jsonb_array_elements((select value->'positions' from tests_vars where key = 'rep_first')) p),
  '["gram-altin", "has-altin"]'::jsonb,
  'İlk düzeltme yanıtı: [eski ürün, yeni ürün] pozisyonları');

select is(
  (select value->'positions' from tests_vars where key = 'rep_again'),
  (select value->'positions' from tests_vars where key = 'rep_first'),
  'Replay düzeltme yanıtı ilk yanıtla AYNI pozisyon dizisini döner');

select is(
  (select value->>'replayed' from tests_vars where key = 'rep_again'),
  'true', 'Replay düzeltme replayed=true döner');

select is(
  (select ledger_revision from public.portfolios where user_id = '11111111-1111-1111-1111-111111111111'),
  (select (value)::bigint from tests_vars where key = 'rev_rep'),
  'Replay düzeltme sürümü artırmaz');

-- Sayısal sınırlar ve sıkı ayrıştırma
select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '1000000000000', 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Tutar 13 tam basamağa ulaşınca P0004 (numeric(20,8) taşması olmaz)');

-- Birikimli maliyet de sınırı aşamaz: iki büyük alış toplamı 12 basamağı geçince ikinci alış P0004
do $$
begin
  perform public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '600000000000', 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', 'req-pgtap-big-1'));
end;
$$;

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-13', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '600000000000', 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Birikimli pozisyon maliyeti 12 basamağı aşacaksa işlem P0004 ile reddedilir (projeksiyon taşmaz)');

do $$
begin
  perform public.ledger_void('22222222-2222-2222-2222-222222222222',
    (select id from public.transactions where client_request_id = 'req-pgtap-big-1'), 'temizlik');
end;
$$;

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '0.000001', 'unit', 'gram',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'TOTAL_AMOUNT', 'unit_price', null,
    'total_amount', '500000000000', 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Çok küçük miktar + büyük tutar: efektif birim değer taşması P0004 ile reddedilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1e3', 'unit', 'gram',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'Bilimsel gösterim (1e3) sıkı ayrıştırmada P0004 (22P02 değil)');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', 'NaN',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null))$$,
  'P0004', NULL,
  'NaN fiyat P0004 ile reddedilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'BUY', 'product_id', 'altin-8-ayar', 'quantity', '1', 'unit', 'gram',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'UNIT_PRICE', 'unit_price', '3000',
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'ACTUAL',
    'note', '', 'client_request_id', null, 'replaces_transaction_id', 'olmayan-kimlik'))$$,
  'P0004', NULL,
  'Geçersiz UUID kontrolsüz 22P02 yerine P0004 üretir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now() - interval '2 hours', 'fetched_at', now())))$$,
  'P0004', NULL,
  'Sağlayıcı zamanı 2 saat eskiyse veri şimdi çekilmiş görünse bile baseline reddedilir');

select throws_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now() - interval '8 minutes', 'fetched_at', now() - interval '8 minutes',
      'stale_after_ms', 300000)))$$,
  'P0004', NULL,
  'Sağlayıcının stale_after_ms (5 dk) sınırı SQL tarafında da uygulanır (TypeScript ile aynı sonuç)');

select lives_ok(
  $$select public.ledger_append('22222222-2222-2222-2222-222222222222', jsonb_build_object(
    'kind', 'OPENING_BALANCE', 'product_id', 'gremse-altin', 'quantity', '1', 'unit', 'adet',
    'occurred_at', '2026-02-12', 'pricing_input_mode', 'MARKET_BASELINE', 'unit_price', null,
    'total_amount', null, 'fees', '0', 'workmanship', '0', 'cost_basis_origin', 'MARKET_BASELINE',
    'note', '', 'client_request_id', null,
    'baseline_snapshot', jsonb_build_object('liquidation_price', '11000', 'replacement_price', '11300',
      'provider', 'mock', 'market', 'TEST', 'currency', 'TRY', 'provider_status', 'ok',
      'is_real_market_data', false, 'provider_timestamp', now() + interval '2 minutes', 'fetched_at', now() + interval '2 minutes',
      'stale_after_ms', 300000)))$$,
  '5 dakikalık küçük saat farkı toleransı çalışır');

-- Hesap silme cascade: gerçek auth.users silme sonrası bütün satırlar sıfırlanır
insert into public.app_sessions (user_id, token_hash, expires_at, absolute_expires_at)
values ('44444444-4444-4444-4444-444444444444', 'pgtap-token-hash-c', now() + interval '1 day', now() + interval '1 day');

select ok(
  (select count(*) from public.transactions where user_id = '44444444-4444-4444-4444-444444444444') > 0
  and (select count(*) from public.price_snapshots where user_id = '44444444-4444-4444-4444-444444444444') > 0
  and (select count(*) from public.app_sessions where user_id = '44444444-4444-4444-4444-444444444444') > 0
  and (select count(*) from public.user_preferences where user_id = '44444444-4444-4444-4444-444444444444') > 0
  and (select count(*) from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444') > 0,
  'Cascade öncesi: Kullanıcı C''nin profil, portföy, işlem, anlık görüntü, oturum ve tercih satırları var');

select lives_ok(
  $$delete from auth.users where id = '44444444-4444-4444-4444-444444444444'$$,
  'auth.users silme (hesap silme) başarılı');

select is(
  (select count(*)::int from public.profiles where id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.portfolios where user_id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.transactions where user_id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.price_snapshots where user_id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.portfolio_positions where user_id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.app_sessions where user_id = '44444444-4444-4444-4444-444444444444')
  + (select count(*)::int from public.user_preferences where user_id = '44444444-4444-4444-4444-444444444444'),
  0,
  'Cascade sonrası: profiles, portfolios, transactions, price_snapshots, portfolio_positions, app_sessions, user_preferences satırları sıfır');

select throws_ok(
  $$delete from public.transactions where user_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', NULL,
  'Cascade dışı doğrudan işlem silme hâlâ reddedilir');

select throws_ok(
  $$delete from public.price_snapshots where user_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', NULL,
  'Cascade dışı doğrudan anlık görüntü silme hâlâ reddedilir');

-- =============================================================================
-- 15. FİYAT KAYNAKLARI VE YÖNETİCİ MFA (0013 / 0014 / 0015)
-- =============================================================================

-- Fiyat tabloları istemciye kapalıdır (tercih/olay tabloları hariç: yalnızca kendi satırı)
select ok(
  (select bool_and(
     not has_table_privilege('anon', t, 'SELECT')
     and not has_table_privilege('anon', t, 'INSERT')
     and not has_table_privilege('authenticated', t, 'INSERT')
     and not has_table_privilege('authenticated', t, 'UPDATE')
     and not has_table_privilege('authenticated', t, 'DELETE')
     and not has_table_privilege('service_role', t, 'INSERT')
     and not has_table_privilege('service_role', t, 'UPDATE')
     and not has_table_privilege('service_role', t, 'DELETE'))
   from unnest(array[
     'public.price_providers', 'public.price_product_mappings', 'public.price_ingestion_runs',
     'public.current_price_quotes', 'public.price_quote_history', 'public.provider_health_snapshots',
     'public.portfolio_price_preferences', 'public.price_source_change_events'
   ]) as t),
  'Fiyat tabloları: anon kapalı, authenticated ve service_role YAZAMAZ (yalnızca RPC)'
);

select ok(
  not has_table_privilege('authenticated', 'public.price_providers', 'SELECT')
  and not has_table_privilege('authenticated', 'public.current_price_quotes', 'SELECT')
  and has_table_privilege('authenticated', 'public.portfolio_price_preferences', 'SELECT')
  and has_table_privilege('authenticated', 'public.price_source_change_events', 'SELECT'),
  'Sağlayıcı ve fiyat tabloları istemciye kapalı; kullanıcı yalnızca kendi tercih/olay satırını okur'
);

select ok(
  (select bool_and(
     has_function_privilege('service_role', f, 'execute')
     and not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
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
   ]) as f),
  'Fiyat RPC''leri yalnızca service_role tarafından çağrılabilir'
);

select ok(
  (select bool_and(
     not has_table_privilege('anon', t, 'SELECT')
     and not has_table_privilege('authenticated', t, 'SELECT')
     and has_table_privilege('service_role', t, 'SELECT'))
   from unnest(array['public.admin_mfa_credentials', 'public.admin_mfa_recovery_codes']) as t),
  'Yönetici MFA tabloları istemciye tamamen kapalıdır'
);

-- Katalog eşitleme ve lisans kapısı
select is(
  public.price_providers_sync(jsonb_build_array(
    jsonb_build_object('code', 'test-lisansli', 'displayName', 'Test Lisanslı', 'technicalName', 'Test',
      'marketId', 'turkiye-genel', 'marketDisplayName', 'Genel Türkiye', 'providerType', 'REST',
      'licenseStatus', 'LICENSED', 'licenseReference', 'SOZ-1', 'redistributionAllowed', true,
      'capabilities', '["REST","PRODUCT_LEVEL"]'::jsonb, 'attribution', 'Test', 'referenceUrl', null),
    jsonb_build_object('code', 'test-lisanssiz', 'displayName', 'Test Lisanssız', 'technicalName', 'Test',
      'marketId', 'turkiye-genel', 'marketDisplayName', 'Genel Türkiye', 'providerType', 'REST',
      'licenseStatus', 'LICENSE_REQUIRED', 'licenseReference', null, 'redistributionAllowed', false,
      'capabilities', '["REST"]'::jsonb, 'attribution', 'Test', 'referenceUrl', null),
    jsonb_build_object('code', 'test-referans', 'displayName', 'Test Referans', 'technicalName', 'Test',
      'marketId', 'bist', 'marketDisplayName', 'BIST Referans', 'providerType', 'REFERENCE',
      'licenseStatus', 'LICENSED', 'licenseReference', 'SOZ-2', 'redistributionAllowed', true,
      'capabilities', '["REST","REFERENCE_ONLY"]'::jsonb, 'attribution', 'Test', 'referenceUrl', null)
  )),
  3, 'Katalog eşitlemesi üç sağlayıcı yazar');

select is(
  public.price_providers_sync(jsonb_build_array(
    jsonb_build_object('code', 'test-lisansli', 'displayName', 'Test Lisanslı', 'technicalName', 'Test',
      'marketId', 'turkiye-genel', 'marketDisplayName', 'Genel Türkiye', 'providerType', 'REST',
      'licenseStatus', 'LICENSED', 'licenseReference', 'SOZ-1', 'redistributionAllowed', true,
      'capabilities', '["REST","PRODUCT_LEVEL"]'::jsonb, 'attribution', 'Test', 'referenceUrl', null)
  )),
  1, 'Katalog eşitlemesi idempotenttir');

select throws_ok(
  $q$select public.price_provider_set_flags('test-lisanssiz', true, true)$q$,
  'P0006', NULL,
  'Lisanssız kaynak ETKİNLEŞTİRİLEMEZ (fail closed)');

select throws_ok(
  $q$select public.price_provider_set_flags('test-lisansli', false, true)$q$,
  'P0004', NULL,
  'Kapalı kaynak kullanıcıya sunulamaz');

select lives_ok(
  $q$select public.price_provider_set_flags('test-lisansli', true, true)$q$,
  'Lisanslı kaynak etkinleştirilip kullanıcıya açılabilir');

select lives_ok(
  $q$select public.price_provider_set_flags('test-referans', true, false)$q$,
  'Referans kaynağı etkinleştirilebilir (yalnızca kontrol amaçlı)');

-- Fiyat alımı: idempotent, karantina sayacı, tarih geçmişi
select is(
  (public.price_ingestion_apply('test-lisansli', 'run-pgtap-1', jsonb_build_object(
    'status', 'ok', 'safeErrorCode', null, 'latencyMs', '12', 'fetchedAt', now(),
    'quotes', jsonb_build_array(
      jsonb_build_object('canonicalProductId', 'gram-altin', 'liquidationPrice', '5000',
        'replacementPrice', '5050', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'rawPayloadHash', 'h1')),
    'quarantined', jsonb_build_array()))->>'status'),
  'SUCCESS', 'Fiyat alımı uygulanır ve SUCCESS döner');

select is(
  (public.price_ingestion_apply('test-lisansli', 'run-pgtap-1', jsonb_build_object(
    'status', 'ok', 'safeErrorCode', null, 'latencyMs', '12', 'fetchedAt', now(),
    'quotes', jsonb_build_array(
      jsonb_build_object('canonicalProductId', 'gram-altin', 'liquidationPrice', '9999',
        'replacementPrice', '9999', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'rawPayloadHash', 'h2')),
    'quarantined', jsonb_build_array()))->>'replayed'),
  'true', 'Aynı koşum anahtarı ikinci kez uygulanmaz (idempotent)');

select is(
  (select public.ledger_num_text(liquidation_price) from public.current_price_quotes
   where canonical_product_id = 'gram-altin'
     and provider_id = (select id from public.price_providers where code = 'test-lisansli')),
  '5000', 'Replay güncel fiyatı DEĞİŞTİRMEZ');

select is(
  (select count(*)::int from public.price_quote_history
   where provider_id = (select id from public.price_providers where code = 'test-lisansli')),
  1, 'Replay tarihçede ikinci kayıt oluşturmaz');

select is(
  (public.price_ingestion_apply('test-lisansli', 'run-pgtap-2', jsonb_build_object(
    'status', 'partial', 'safeErrorCode', 'PARTIAL_COVERAGE', 'latencyMs', '20', 'fetchedAt', now(),
    'quotes', jsonb_build_array(
      jsonb_build_object('canonicalProductId', 'gram-altin', 'liquidationPrice', '5010',
        'replacementPrice', '5060', 'upstreamSourceId', 'kayseri', 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'rawPayloadHash', 'h3')),
    'quarantined', jsonb_build_array(jsonb_build_object('canonicalProductId', 'ata-altin', 'code', 'INVERTED_SPREAD'))
  ))->>'status'),
  'PARTIAL', 'Karantinalı kayıt olan koşum PARTIAL olur');

select is(
  (select quarantined_count from public.provider_health_snapshots
   where provider_id = (select id from public.price_providers where code = 'test-lisansli')),
  1, 'Karantina sayısı sağlık kaydına yazılır');

select is(
  (select count(*)::int from public.current_price_quotes
   where provider_id = (select id from public.price_providers where code = 'test-lisansli')
     and canonical_product_id = 'ata-altin'),
  0, 'Karantinaya alınan ürün güncel fiyata GİRMEZ');

select throws_ok(
  $q$update public.price_quote_history set liquidation_price = 1$q$,
  '42501', NULL,
  'Fiyat geçmişi değiştirilemez (append-only)');

select throws_ok(
  $q$delete from public.price_quote_history$q$,
  '42501', NULL,
  'Fiyat geçmişi silinemez');

select throws_ok(
  $q$insert into public.current_price_quotes
      (provider_id, market_id, canonical_product_id, liquidation_price, replacement_price,
       provider_timestamp, fetched_at, mapping_version)
    values ((select id from public.price_providers where code = 'test-lisansli'), 'turkiye-genel',
            'has-altin', 5000, 4000, now(), now(), 'v1')$q$,
  '23514', NULL,
  'Ters makaslı güncel fiyat tablo kısıtıyla reddedilir');

-- Kaynak tercihi ve denetim olayı
select throws_ok(
  $q$select public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-lisanssiz',
      '11111111-1111-1111-1111-111111111111', 'user', 'deneme')$q$,
  'P0006', NULL,
  'Kullanıcı kapalı kaynağı seçemez');

select throws_ok(
  $q$select public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-referans',
      '11111111-1111-1111-1111-111111111111', 'user', 'deneme')$q$,
  'P0006', NULL,
  'Referans kaynağı değerleme için seçilemez');

select is(
  (public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-lisansli',
     '11111111-1111-1111-1111-111111111111', 'user', 'ilk seçim')->>'changed'),
  'true', 'Kullanıcı açık kaynağı seçebilir');

select is(
  (public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-lisansli',
     '11111111-1111-1111-1111-111111111111', 'user', 'tekrar')->>'changed'),
  'false', 'Aynı kaynağa tekrar seçim değişiklik saymaz');

select is(
  (select count(*)::int from public.price_source_change_events
   where user_id = '11111111-1111-1111-1111-111111111111'),
  1, 'Kaynak değişimi tam olarak bir denetim olayı üretir');

select is(
  (select jsonb_array_length(public.price_source_events('11111111-1111-1111-1111-111111111111', 10))),
  1, 'Kaynak değişim geçmişi okunabilir');

select is(
  (select jsonb_array_length(public.price_source_events('22222222-2222-2222-2222-222222222222', 10))),
  0, 'Başka kullanıcının kaynak geçmişi boştur (izolasyon)');

select throws_ok(
  $q$update public.price_source_change_events set reason = 'değiştirildi'$q$,
  '42501', NULL,
  'Kaynak değişim kaydı değiştirilemez');

select is(
  (public.price_quotes_current('test-lisansli')->>'marketId'),
  'turkiye-genel', 'Güncel fiyat okuması sağlayıcı ve piyasa bilgisini taşır');

select is(
  (select jsonb_array_length(public.price_quotes_compare(array['test-lisansli', 'test-referans']))),
  2, 'Karşılaştırma birden çok sağlayıcıyı döner');

-- Yönetici MFA
select ok(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'app_sessions' and column_name = 'mfa_verified_at') = 1,
  'Oturumda ikinci faktör doğrulama zamanı alanı vardır');

select ok(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'admin_mfa_credentials'
     and column_name in ('secret_ciphertext', 'secret_nonce')) = 2,
  'TOTP secret şifreli alanlarda tutulur (düz metin sütunu yoktur)');

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'admin_mfa_credentials' and column_name = 'secret'),
  0, 'Düz metin secret sütunu YOKTUR');

select lives_ok(
  $q$insert into public.admin_audit_logs (admin_user_id, admin_username, action, success)
    values ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'mfa.enroll', true)$q$,
  'Yeni denetim eylemleri (mfa.enroll) kısıtta tanımlıdır');

select lives_ok(
  $q$insert into public.admin_audit_logs (admin_user_id, admin_username, action, success)
    values ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'price.provider_update', true)$q$,
  'Fiyat kaynağı denetim eylemi kısıtta tanımlıdır');

select throws_ok(
  $q$insert into public.admin_audit_logs (admin_user_id, admin_username, action, success)
    values ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'bilinmeyen.eylem', true)$q$,
  '23514', NULL,
  'Tanımsız denetim eylemi reddedilir');

-- =============================================================================
-- 16. FİYAT ÇALIŞMA ZAMANI BÜTÜNLÜĞÜ (0016)
-- =============================================================================

-- Karantina tablosu istemciye kapalıdır ve append-only'dir.
select ok(
  not has_table_privilege('anon', 'public.price_quote_quarantine', 'SELECT')
  and not has_table_privilege('authenticated', 'public.price_quote_quarantine', 'SELECT')
  and has_table_privilege('service_role', 'public.price_quote_quarantine', 'SELECT')
  and not has_table_privilege('service_role', 'public.price_quote_quarantine', 'INSERT')
  and not has_table_privilege('service_role', 'public.price_quote_quarantine', 'UPDATE')
  and not has_table_privilege('service_role', 'public.price_quote_quarantine', 'DELETE'),
  'Karantina tablosu: istemciye kapalı, service_role yalnızca okur'
);

select ok(
  (select count(*) from pg_trigger
   where tgrelid = 'public.price_quote_quarantine'::regclass
     and tgname in ('price_quote_quarantine_no_update', 'price_quote_quarantine_no_delete')) = 2,
  'Karantina kayıtları tetikleyiciyle değiştirilemez ve silinemez'
);

select ok(
  (select bool_and(
     has_function_privilege('service_role', f, 'execute')
     and not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.price_quarantine_list(text, integer)',
     'public.price_provider_set_default(text)'
   ]) as f),
  'Yeni fiyat RPC leri yalnızca service_role tarafından çağrılabilir'
);

-- Sertleştirilmiş ingestion: sağlayıcı durumu veritabanında da denetlenir.
select throws_ok(
  $q$select public.price_ingestion_apply('test-lisanssiz', 'run-kapali', jsonb_build_object(
      'status', 'ok', 'safeErrorCode', null, 'latencyMs', '1', 'fetchedAt', now(),
      'quotes', jsonb_build_array(), 'quarantined', jsonb_build_array()))$q$,
  'P0006', NULL,
  'Kapalı/lisanssız sağlayıcı fiyat YAZAMAZ (veritabanı seviyesinde)'
);

select throws_ok(
  $q$select public.price_ingestion_apply('test-referans', 'run-referans', jsonb_build_object(
      'status', 'ok', 'safeErrorCode', null, 'latencyMs', '1', 'fetchedAt', now(),
      'quotes', jsonb_build_array(), 'quarantined', jsonb_build_array()))$q$,
  'P0006', NULL,
  'Referans kaynağı güncel değerleme tablosuna YAZAMAZ'
);

-- Geçersiz kayıtlar karantinaya alınır ve güncel fiyata girmez.
select is(
  (public.price_ingestion_apply('test-lisansli', 'run-kalite-1', jsonb_build_object(
    'status', 'ok', 'safeErrorCode', null, 'latencyMs', '5', 'fetchedAt', now(),
    'quotes', jsonb_build_array(
      jsonb_build_object('canonicalProductId', 'yeni-ceyrek', 'liquidationPrice', '11000',
        'replacementPrice', '10000', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'currency', 'TRY'),
      jsonb_build_object('canonicalProductId', 'bilinmeyen-urun', 'liquidationPrice', '1',
        'replacementPrice', '2', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'currency', 'TRY'),
      jsonb_build_object('canonicalProductId', 'eski-ceyrek', 'liquidationPrice', '9000',
        'replacementPrice', '9100', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'currency', 'USD')),
    'quarantined', jsonb_build_array()))->>'quoteCount'),
  '0', 'Ters makas, bilinmeyen ürün ve yabancı para birimi güncel fiyata GİRMEZ'
);

select is(
  (select count(*)::int from public.price_quote_quarantine q
   join public.price_ingestion_runs r on r.id = q.ingestion_run_id
   where r.run_key = 'run-kalite-1'),
  3, 'Üç geçersiz kayıt karantinaya KALICI olarak yazıldı'
);

select is(
  (select rejection_code from public.price_quote_quarantine q
   where q.canonical_product_id = 'yeni-ceyrek' limit 1),
  'INVERTED_SPREAD', 'Karantina kaydı reddetme sebebini saklar'
);

select is(
  (select liquidation_price::text from public.price_quote_quarantine q
   where q.canonical_product_id = 'yeni-ceyrek' limit 1),
  '11000.00000000', 'Karantina kaydı reddedilen fiyatı saklar'
);

select throws_ok(
  $q$update public.price_quote_quarantine set rejection_code = 'DEGISTI'$q$,
  '42501', NULL,
  'Karantina kaydı GÜNCELLENEMEZ'
);

select throws_ok(
  $q$delete from public.price_quote_quarantine$q$,
  '42501', NULL,
  'Karantina kaydı SİLİNEMEZ'
);

-- Aynı koşumda aynı kanonik ürün iki kez kabul edilmez.
select is(
  (public.price_ingestion_apply('test-lisansli', 'run-dup-1', jsonb_build_object(
    'status', 'ok', 'safeErrorCode', null, 'latencyMs', '5', 'fetchedAt', now(),
    'quotes', jsonb_build_array(
      jsonb_build_object('canonicalProductId', 'gram-altin', 'liquidationPrice', '5000',
        'replacementPrice', '5050', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'currency', 'TRY'),
      jsonb_build_object('canonicalProductId', 'gram-altin', 'liquidationPrice', '9999',
        'replacementPrice', '9999', 'upstreamSourceId', null, 'providerTimestamp', now(),
        'fetchedAt', now(), 'status', 'ok', 'mappingVersion', 'v1', 'currency', 'TRY')),
    'quarantined', jsonb_build_array()))->>'quoteCount'),
  '1', 'Aynı koşumda yinelenen kanonik ürün kabul edilmez'
);

select is(
  (select liquidation_price::text from public.current_price_quotes q
   join public.price_providers p on p.id = q.provider_id
   where p.code = 'test-lisansli' and q.canonical_product_id = 'gram-altin'),
  '5000.00000000', 'İlk kayıt korunur; son kayıt kazanır davranışı YOKTUR'
);

select is(
  (select rejection_code from public.price_quote_quarantine q
   where q.rejection_code = 'DUPLICATE_CANONICAL_PRODUCT' limit 1),
  'DUPLICATE_CANONICAL_PRODUCT', 'Yinelenen kayıt karantinaya alınır'
);

-- Global varsayılan kaynak
select is(
  (public.price_provider_set_default('test-lisansli')->>'providerCode'),
  'test-lisansli', 'Yönetici açık global varsayılan kaynağı belirleyebilir'
);

select throws_ok(
  $q$select public.price_provider_set_default('test-referans')$q$,
  'P0006', NULL,
  'Referans kaynağı global varsayılan YAPILAMAZ'
);

select throws_ok(
  $q$select public.price_provider_set_default('test-lisanssiz')$q$,
  'P0006', NULL,
  'Kapalı kaynak global varsayılan YAPILAMAZ'
);

select is(
  (select count(*)::int from public.price_providers where is_default),
  1, 'En fazla bir global varsayılan bulunur'
);

select lives_ok(
  $q$select public.price_provider_set_flags('test-lisansli', false, false)$q$,
  'Varsayılan kaynak kapatılabilir'
);

select is(
  (select count(*)::int from public.price_providers where is_default),
  0, 'Kapatılan kaynak varsayılanlıktan da düşer'
);

-- Yönetici TOTP replay koruması için sayaç sütunu
select has_column('public', 'admin_mfa_credentials', 'last_used_counter',
  'admin_mfa_credentials.last_used_counter bulunur (TOTP replay koruması)');

select ok(
  (select atttypid::regtype::text from pg_attribute
   where attrelid = 'public.admin_mfa_credentials'::regclass
     and attname = 'last_used_counter') = 'bigint',
  'last_used_counter bigint türündedir'
);

-- =============================================================================
-- 17. SARRAF TV ÖZEL PİLOTU (0017): deneysel kaynak, worker kirası, izin listesi
-- =============================================================================

-- Şema: pilot tabloları vardır ve istemciye tamamen kapalıdır.
select ok(
  (select bool_and(
     not has_table_privilege('anon', t, 'SELECT')
     and not has_table_privilege('authenticated', t, 'SELECT')
     and not has_table_privilege('authenticated', t, 'INSERT')
     and not has_table_privilege('service_role', t, 'INSERT')
     and not has_table_privilege('service_role', t, 'UPDATE')
     and not has_table_privilege('service_role', t, 'DELETE'))
   from unnest(array[
     'public.experimental_price_access', 'public.price_mapping_approvals',
     'public.price_worker_nonces', 'public.price_worker_leases'
   ]) as t),
  'Pilot tabloları: istemci okuyamaz, hiçbir rol doğrudan yazamaz (yalnızca RPC)'
);

select ok(
  (select bool_and(
     has_function_privilege('service_role', f, 'execute')
     and not has_function_privilege('anon', f, 'execute')
     and not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.price_worker_nonce_claim(text, text)',
     'public.price_worker_lease_acquire(text, text, integer)',
     'public.price_worker_lease_state(text)',
     'public.experimental_access_set(uuid, text, boolean, uuid, text, timestamptz)',
     'public.experimental_access_allowed(uuid, text)',
     'public.experimental_access_list(text)',
     'public.price_mapping_approve(text, text, text, text, uuid, numeric, numeric, timestamptz, boolean)',
     'public.price_mapping_approvals_list(text)'
   ]) as f),
  'Pilot RPC''leri yalnızca service_role tarafından çağrılabilir'
);

-- Deneysel kaynak kataloğa girer.
select is(
  public.price_providers_sync(jsonb_build_array(
    jsonb_build_object('code', 'test-deneysel', 'displayName', 'Test Deneysel', 'technicalName', 'Ekran',
      'marketId', 'kayseri', 'marketDisplayName', 'Kayseri Yerel Piyasa', 'providerType', 'SCREEN',
      'licenseStatus', 'EXPERIMENTAL_PRIVATE', 'licenseReference', null, 'redistributionAllowed', false,
      'capabilities', '["EXPERIMENTAL_SCREEN","PRODUCT_LEVEL"]'::jsonb,
      'attribution', 'Sarraf TV', 'referenceUrl', null)
  )),
  1, 'Deneysel kaynak kataloğa yazılır');

select is(
  (select license_status from public.price_providers where code = 'test-deneysel'),
  'EXPERIMENTAL_PRIVATE', 'Lisans durumu EXPERIMENTAL_PRIVATE olarak saklanır');

-- Etkinleştirilebilir ama genel listeye açılamaz.
select lives_ok(
  $q$select public.price_provider_set_flags('test-deneysel', true, false)$q$,
  'Deneysel kaynak etkinleştirilebilir (kullanıcı seçimine kapalı)');

select throws_ok(
  $q$select public.price_provider_set_flags('test-deneysel', true, true)$q$,
  'P0006', NULL,
  'Deneysel kaynak genel kullanıcı listesine AÇILAMAZ');

select throws_ok(
  $q$select public.price_provider_set_default('test-deneysel')$q$,
  'P0006', NULL,
  'Deneysel kaynak global varsayılan yapılamaz');

-- İzin listesi olmadan kullanıcı bu kaynağı seçemez.
select is(
  public.experimental_access_allowed('11111111-1111-1111-1111-111111111111', 'test-deneysel'),
  false, 'İzin verilmeden erişim yoktur');

select throws_ok(
  $q$select public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-deneysel',
      '11111111-1111-1111-1111-111111111111', 'user', 'izinsiz')$q$,
  'P0006', NULL,
  'İzin listesinde olmayan kullanıcı deneysel kaynağı seçemez');

-- Yönetici izin verir.
select lives_ok(
  $q$select public.experimental_access_set('11111111-1111-1111-1111-111111111111', 'test-deneysel',
      true, '22222222-2222-2222-2222-222222222222', 'pilot', null)$q$,
  'Yönetici pilot erişimi verebilir');

select is(
  public.experimental_access_allowed('11111111-1111-1111-1111-111111111111', 'test-deneysel'),
  true, 'İzin verilen kullanıcı için erişim açıktır');

select is(
  (public.price_preference_set('11111111-1111-1111-1111-111111111111', 'test-deneysel',
     '11111111-1111-1111-1111-111111111111', 'user', 'pilot seçimi')->>'providerCode'),
  'test-deneysel', 'İzinli kullanıcı deneysel kaynağı seçebilir');

-- Süresi geçmiş izin erişim sayılmaz.
select lives_ok(
  $q$select public.experimental_access_set('11111111-1111-1111-1111-111111111111', 'test-deneysel',
      true, '22222222-2222-2222-2222-222222222222', 'süresi doldu', now() - interval '1 hour')$q$,
  'İzne bitiş zamanı verilebilir');

select is(
  public.experimental_access_allowed('11111111-1111-1111-1111-111111111111', 'test-deneysel'),
  false, 'Süresi dolan izin erişim SAYILMAZ');

select lives_ok(
  $q$select public.experimental_access_set('11111111-1111-1111-1111-111111111111', 'test-deneysel',
      false, '22222222-2222-2222-2222-222222222222', 'geri alındı', null)$q$,
  'İzin geri alınabilir');

select is(
  public.experimental_access_allowed('11111111-1111-1111-1111-111111111111', 'test-deneysel'),
  false, 'Geri alınan izin erişim sayılmaz');

-- Nonce tek kullanımlıktır.
select is(
  public.price_worker_nonce_claim('pgtap-nonce-1', 'w-pgtap'),
  true, 'Nonce ilk kez kabul edilir');

select is(
  public.price_worker_nonce_claim('pgtap-nonce-1', 'w-pgtap'),
  false, 'Aynı nonce İKİNCİ kez kabul edilmez (replay engellenir)');

-- Kira: tek worker tutar; devralma yalnızca süre dolunca olur.
select is(
  (public.price_worker_lease_acquire('test-deneysel', 'w-1', 180)->>'held'),
  'true', 'İlk worker kirayı alır');

select is(
  (public.price_worker_lease_acquire('test-deneysel', 'w-2', 180)->>'held'),
  'false', 'İkinci worker aynı anda kirayı ALAMAZ');

select is(
  (public.price_worker_lease_state('test-deneysel')->>'workerId'),
  'w-1', 'Kira durumu kirayı tutan worker''ı bildirir');

select is(
  (public.price_worker_lease_acquire('test-deneysel', 'w-1', 180)->>'takeover'),
  'false', 'Kirayı tutan worker yenilerken devralma SAYILMAZ');

select is(
  (public.price_worker_lease_state('test-deneysel')->>'active'),
  'true', 'Süresi dolmamış kira etkin görünür');

-- Eşleme onayı: onaysız eşleme değerlemeye giremez.
select is(
  (select count(*)::int from public.price_mapping_approvals), 0,
  'Başlangıçta onaylı eşleme yoktur');

select lives_ok(
  $q$select public.price_mapping_approve('test-deneysel', 'gremse', 'gram-altin',
      'pgtap-mapping-1', '22222222-2222-2222-2222-222222222222',
      4100.00, 4200.00, now(), false)$q$,
  'Yönetici ekran etiketini ürüne onaylayabilir');

select is(
  (select count(*)::int from public.price_mapping_approvals a
   join public.price_providers p on p.id = a.provider_id
   where p.code = 'test-deneysel' and a.revoked_at is null), 1,
  'Onay kaydı yazılır');

select is(
  (public.price_mapping_approvals_list('test-deneysel')->0->>'canonicalProductId'),
  'gram-altin', 'Onay listesi ürünü döndürür');

select is(
  (public.price_mapping_approvals_list('test-deneysel')->0->>'confidence'),
  'OPERATOR_VERIFIED', 'Yönetici onayı OPERATOR_VERIFIED güveniyle kaydedilir');

-- Deneysel kaynak fiyat yazabilir (ingestion kapısı EXPERIMENTAL_PRIVATE'a açıktır).
select lives_ok(
  $q$select public.price_ingestion_apply('test-deneysel', 'pgtap-run-deneysel', jsonb_build_object(
     'fetchedAt', now()::text,
     'quotes', jsonb_build_array()))$q$,
  'Deneysel kaynak alım çalıştırması kabul edilir');

-- Lisanssız kaynak hâlâ reddedilir (0017 kapıyı yalnızca deneysele açtı).
select throws_ok(
  $q$select public.price_provider_set_flags('test-lisanssiz', true, true)$q$,
  'P0006', NULL,
  'Lisanssız kaynak 0017''den sonra da etkinleştirilemez');


select * from finish();

rollback;
