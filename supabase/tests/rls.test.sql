-- =============================================================================
-- Altın Takip — RLS davranış testleri (pgTAP)
--
-- Çalıştırma:  npm run test:db      (Supabase CLI + Docker gerektirir)
--              supabase test db
--
-- Bu testler POLİTİKALARIN GERÇEKTEN uygulandığını doğrular; SQL metnini
-- okumakla yetinmez. Her test, ilgili rolü üstlenip (authenticated / anon)
-- auth.uid() değerini ayarlayarak gerçek bir istemci gibi sorgu çalıştırır.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

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

/** Kurulum için tam yetkili role döner. */
create or replace function tests.become_service()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- Test verisi
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
   'authenticated', 'authenticated', 'admin@users.altin-takip.invalid', 'x', now(), now(), now());

insert into public.profiles (id, username, display_name, role, status, must_change_password)
values
  ('11111111-1111-1111-1111-111111111111', 'kullanicia', 'Kullanıcı A', 'user', 'active', false),
  ('22222222-2222-2222-2222-222222222222', 'kullanicib', 'Kullanıcı B', 'user', 'active', false),
  ('33333333-3333-3333-3333-333333333333', 'yoneticix', 'Yönetici X', 'admin', 'active', false);

insert into public.portfolios (id, user_id, name)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A Portföy'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'B Portföy');

insert into public.transactions
  (id, user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price, fee_amount)
values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'gram-altin', 'buy', 10, 'gram', '2026-01-10', 5000, 0),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-0000-0000-0000-000000000002', 'gram-altin', 'buy', 4, 'gram', '2026-01-11', 5100, 0);

insert into public.admin_audit_logs (admin_user_id, admin_username, target_user_id, target_username, action, success)
values ('33333333-3333-3333-3333-333333333333', 'yoneticix',
        '11111111-1111-1111-1111-111111111111', 'kullanicia', 'user.view', true);

insert into public.app_sessions (id, user_id, token_hash, device_mode, expires_at, absolute_expires_at)
values ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'ornek-token-ozeti', 'personal', now() + interval '1 day', now() + interval '1 day');

-- -----------------------------------------------------------------------------
-- KULLANICI A — kendi verisi
-- -----------------------------------------------------------------------------

select tests.authenticate_as('11111111-1111-1111-1111-111111111111');

select is(
  (select count(*)::int from public.profiles),
  1,
  'Kullanıcı A yalnızca kendi profilini görebilir'
);

select is(
  (select username from public.profiles),
  'kullanicia',
  'Kullanıcı A görebildiği tek profil kendisininkidir'
);

select is(
  (select count(*)::int from public.portfolios),
  1,
  'Kullanıcı A yalnızca kendi portföyünü görebilir'
);

select is(
  (select count(*)::int from public.transactions),
  1,
  'Kullanıcı A yalnızca kendi işlemlerini görebilir'
);

-- -----------------------------------------------------------------------------
-- KULLANICI A — başka kullanıcının verisi
-- -----------------------------------------------------------------------------

select is(
  (select count(*)::int from public.profiles
   where id = '22222222-2222-2222-2222-222222222222'),
  0,
  'Kullanıcı A, Kullanıcı B profilini okuyamaz'
);

select is(
  (select count(*)::int from public.portfolios
   where user_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'Kullanıcı A, Kullanıcı B portföyünü okuyamaz'
);

select is(
  (select count(*)::int from public.transactions
   where user_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'Kullanıcı A, Kullanıcı B işlemlerini okuyamaz'
);

-- UPDATE politikası eşleşmediği için hiçbir satır etkilenmez.
with attempted as (
  update public.portfolios set name = 'ele geçirildi'
  where user_id = '22222222-2222-2222-2222-222222222222'
  returning 1
)
select is((select count(*)::int from attempted), 0,
  'Kullanıcı A, Kullanıcı B portföyünü değiştiremez');

with attempted as (
  update public.transactions set quantity = 999
  where user_id = '22222222-2222-2222-2222-222222222222'
  returning 1
)
select is((select count(*)::int from attempted), 0,
  'Kullanıcı A, Kullanıcı B işlemlerini değiştiremez');

with attempted as (
  delete from public.transactions
  where user_id = '22222222-2222-2222-2222-222222222222'
  returning 1
)
select is((select count(*)::int from attempted), 0,
  'Kullanıcı A, Kullanıcı B işlemlerini silemez');

-- Başka kullanıcının portföy kimliğiyle işlem eklemek WITH CHECK ile engellenir.
select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('11111111-1111-1111-1111-111111111111',
            'bbbbbbbb-0000-0000-0000-000000000002',
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', 5000)$$,
  '42501',
  NULL,
  'Kullanıcı A, Kullanıcı B portföyüne işlem ekleyemez'
);

-- Kendi user_id'si dışında satır eklemek de engellenir.
select throws_ok(
  $$insert into public.transactions
      (user_id, portfolio_id, product_id, side, quantity, unit, traded_at, unit_price)
    values ('22222222-2222-2222-2222-222222222222',
            'bbbbbbbb-0000-0000-0000-000000000002',
            'gram-altin', 'buy', 1, 'gram', '2026-02-01', 5000)$$,
  '42501',
  NULL,
  'Kullanıcı A başka kullanıcı adına işlem ekleyemez'
);

-- -----------------------------------------------------------------------------
-- KULLANICI A — yetki yükseltme
-- -----------------------------------------------------------------------------

select throws_ok(
  $$update public.profiles set role = 'admin'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  'Kullanıcı A kendi rolünü admin yapamaz'
);

select throws_ok(
  $$update public.profiles set status = 'inactive'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  'Kullanıcı A kendi hesap durumunu değiştiremez'
);

select throws_ok(
  $$update public.profiles set username = 'yenidad'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  'Kullanıcı A kullanıcı adını değiştiremez'
);

select throws_ok(
  $$update public.profiles set must_change_password = false
    where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  NULL,
  'Kullanıcı A must_change_password alanını değiştiremez'
);

-- Görünen adını değiştirebilmelidir.
select lives_ok(
  $$update public.profiles set display_name = 'Yeni Ad'
    where id = '11111111-1111-1111-1111-111111111111'$$,
  'Kullanıcı A kendi görünen adını değiştirebilir'
);

-- -----------------------------------------------------------------------------
-- KULLANICI A — denetim kaydı ve oturumlar
-- -----------------------------------------------------------------------------

select is(
  (select count(*)::int from public.admin_audit_logs),
  0,
  'Normal kullanıcı denetim kayıtlarını okuyamaz'
);

select is(
  (select count(*)::int from public.app_sessions),
  0,
  'Normal kullanıcı oturum tablosunu okuyamaz'
);

-- -----------------------------------------------------------------------------
-- YÖNETİCİ
-- -----------------------------------------------------------------------------

select tests.authenticate_as('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from public.profiles),
  3,
  'Yönetici tüm profilleri okuyabilir'
);

select ok(
  (select count(*)::int from public.transactions) >= 2,
  'Yönetici kullanıcıların işlemlerini okuyabilir'
);

-- Yönetici için finansal satırlarda YAZMA politikası yoktur.
with attempted as (
  update public.transactions set quantity = 123
  where user_id = '11111111-1111-1111-1111-111111111111'
  returning 1
)
select is((select count(*)::int from attempted), 0,
  'Yönetici kullanıcının finansal kaydını düzenleyemez');

select is(
  (select count(*)::int from public.app_sessions),
  0,
  'Yönetici bile oturum tablosunu okuyamaz'
);

-- -----------------------------------------------------------------------------
-- ANON
-- -----------------------------------------------------------------------------

select tests.become_anon();

select is(
  (select count(*)::int from public.transactions),
  0,
  'Oturumsuz kullanıcı finansal tabloları okuyamaz'
);

select * from finish();

rollback;
