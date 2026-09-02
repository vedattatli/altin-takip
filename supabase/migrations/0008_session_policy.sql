-- =============================================================================
-- Altın Takip — 0008 Oturum politikası: "Bu cihazda oturumumu açık tut"
--
-- Kalıcı (180 gün kaydırmalı) oturum artık kullanıcı tercihine bağlıdır.
--
--   persistent = true  : kalıcı çerez, 180 gün kaydırmalı ömür (≤ 24 saatte bir yenileme)
--   persistent = false : tarayıcı oturumu çerezi, en fazla 8 saat mutlak ömür,
--                        en fazla 30 dakika hareketsizlik (idle_expires_at yeniden kullanımda)
--   admin hesapları    : tercihten bağımsız; en fazla 8 saat mutlak, 15 dakika hareketsizlik,
--                        asla kalıcı değil
--
-- Mevcut kullanıcı oturumları "kalıcı tercih verilmiş" kabul edilir (default true);
-- geçersiz KILINMAZ. Mevcut admin oturumları güvenli sınırlara çekilir.
-- Bu dosya tekrar çalıştırılabilir.
-- =============================================================================

alter table public.app_sessions
  add column if not exists persistent boolean not null default true;

comment on column public.app_sessions.persistent is
  'true: kullanıcı "oturumumu açık tut" seçti (kalıcı çerez, 180 gün kaydırmalı). false: tarayıcı oturumu; 8 saat mutlak + 30 dk hareketsizlik.';

comment on column public.app_sessions.idle_expires_at is
  'Kalıcı olmayan oturumlarda hareketsizlik bitişi (kullanıcı 30 dk, admin 15 dk). Kalıcı oturumda null.';

comment on column public.app_sessions.absolute_expires_at is
  'Mutlak bitiş: kalıcı oturumda kaydırmalı bitişle aynı; kalıcı olmayanda giriş + 8 saat (uzatılmaz).';

create index if not exists app_sessions_idle_expires_idx
  on public.app_sessions (idle_expires_at)
  where idle_expires_at is not null;

-- Admin oturumları asla kalıcı olamaz: mevcut admin oturumları 8 saat / 15 dk sınırına çekilir.
update public.app_sessions s
set persistent = false,
    idle_expires_at = least(coalesce(s.idle_expires_at, now() + interval '15 minutes'),
                            now() + interval '15 minutes'),
    absolute_expires_at = least(s.absolute_expires_at, s.created_at + interval '8 hours'),
    expires_at = least(s.expires_at, s.created_at + interval '8 hours')
from public.profiles p
where p.id = s.user_id
  and p.role = 'admin'
  and s.revoked_at is null
  and (s.persistent or s.idle_expires_at is null
       or s.absolute_expires_at > s.created_at + interval '8 hours');

-- Temizlik: hareketsizlik süresi dolan kalıcı olmayan oturumlar da silinir.
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
     or expires_at <= now()
     or absolute_expires_at <= now()
     or (idle_expires_at is not null and idle_expires_at <= now());
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_sessions() from public;
revoke all on function public.purge_expired_sessions() from anon;
revoke all on function public.purge_expired_sessions() from authenticated;
grant execute on function public.purge_expired_sessions() to service_role;
