-- =============================================================================
-- Altın Takip — 0015 Yönetici için TOTP tabanlı ikinci faktör (Sprint 3)
--
-- Yönetici bütün kullanıcıların uygulamaya kaydettiği portföyleri görebildiği
-- için admin hesaplarında MFA ZORUNLUDUR. Normal kullanıcı için zorunlu değildir.
--
-- GÜVENLİK
--  - TOTP secret veritabanında DÜZ METİN tutulmaz: uygulama katmanında
--    AES-256-GCM ile şifrelenir (AUTH_MFA_ENCRYPTION_KEY), yalnızca şifreli
--    metin ve nonce saklanır.
--  - Kurtarma kodları yalnızca SHA-256 özetiyle saklanır; tek kullanımlıktır.
--  - Oturumun MFA seviyesi app_sessions.mfa_verified_at ile taşınır; parola
--    değişikliği MFA'yı sessizce kaldırmaz.
--  - Bu tablolar istemciye tamamen kapalıdır (anon/authenticated erişimi yok).
-- =============================================================================

create table if not exists public.admin_mfa_credentials (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  -- AES-256-GCM ile şifrelenmiş TOTP secret (base64). Düz metin ASLA yazılmaz.
  secret_ciphertext text not null,
  secret_nonce text not null,
  algorithm text not null default 'SHA1',
  digits smallint not null default 6,
  period_seconds smallint not null default 30,
  confirmed_at timestamptz,
  last_verified_at timestamptz,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admin_mfa_digits_check check (digits between 6 and 8),
  constraint admin_mfa_period_check check (period_seconds between 15 and 120)
);

comment on table public.admin_mfa_credentials is
  'Yönetici TOTP kimlik bilgisi. Secret uygulama katmanında şifrelenir; düz metin saklanmaz.';

create table if not exists public.admin_mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Yalnızca SHA-256 özeti; kodun kendisi saklanmaz.
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists admin_mfa_recovery_codes_hash_idx
  on public.admin_mfa_recovery_codes (user_id, code_hash);
create index if not exists admin_mfa_recovery_codes_user_idx
  on public.admin_mfa_recovery_codes (user_id) where used_at is null;

-- Oturumun MFA seviyesi: doğrulanmadıysa admin uçları çalışmaz.
alter table public.app_sessions
  add column if not exists mfa_verified_at timestamptz;

comment on column public.app_sessions.mfa_verified_at is
  'Bu oturumda ikinci faktörün doğrulandığı an. Admin oturumlarında zorunludur.';

-- -----------------------------------------------------------------------------
-- Yetkiler: istemciye tamamen kapalı
-- -----------------------------------------------------------------------------

alter table public.admin_mfa_credentials enable row level security;
alter table public.admin_mfa_credentials force row level security;
alter table public.admin_mfa_recovery_codes enable row level security;
alter table public.admin_mfa_recovery_codes force row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['public.admin_mfa_credentials', 'public.admin_mfa_recovery_codes']
  loop
    execute format('revoke all on table %s from public', tbl);
    execute format('revoke all on table %s from anon', tbl);
    execute format('revoke all on table %s from authenticated', tbl);
    execute format('grant select, insert, update, delete on table %s to service_role', tbl);
  end loop;
end;
$$;

-- Denetim eylemleri: MFA kurulumu ve sıfırlaması ayrı ayrı izlenir.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'admin_audit_logs_action_check'
      and conrelid = 'public.admin_audit_logs'::regclass
  ) then
    alter table public.admin_audit_logs drop constraint admin_audit_logs_action_check;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'admin_audit_logs_action_check'
      and conrelid = 'public.admin_audit_logs'::regclass
  ) then
    alter table public.admin_audit_logs
      add constraint admin_audit_logs_action_check check (
        action in (
          'user.create', 'user.deactivate', 'user.activate', 'user.password_reset',
          'user.view', 'user.portfolio_view', 'user.sessions_view', 'user.sessions_revoke',
          'user.delete_attempt', 'user.delete',
          'mfa.enroll', 'mfa.verify', 'mfa.reset', 'mfa.recovery_used',
          'price.provider_update', 'price.source_change', 'price.refresh',
          'data.export', 'data.deletion_request'
        )
      );
  end if;
end;
$$;
