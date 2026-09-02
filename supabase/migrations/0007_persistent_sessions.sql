-- =============================================================================
-- Altın Takip — 0007 Kalıcı oturum modeli
--
-- ÜRÜN KARARI: Kullanıcılar sık sık yeniden giriş yapmaz. Cihaz türü seçimi,
-- 15 dakikalık hareketsizlik zaman aşımı ve kısa mutlak süreler KALDIRILDI.
-- Bütün cihazlarda aynı, kalıcı ve kaydırmalı (rolling) oturum kullanılır:
--
--   - expires_at        : kaydırmalı bitiş (son yenilemeden 180 gün sonrası)
--   - renewed_at        : bitişin en son ileri alındığı an (≤ 24 saatte bir yazılır)
--   - rotated_at        : oturum kimliğinin en son yenilendiği an (7 günde bir)
--   - previous_token_hash / previous_token_valid_until
--                       : yenileme sonrası eski kimlik kısa süre (60 sn) geçerli kalır
--   - device_label      : kaba, kullanıcı dostu cihaz tanımı ("Chrome · Windows").
--                         Ham User-Agent veya IP SAKLANMAZ.
--
-- Eski alanlar:
--   - device_mode       : yalnızca eski veriyle uyumluluk için kalır; kısıtları
--                         kaldırıldı, iş mantığında KULLANILMAZ.
--   - idle_expires_at   : deprecated; null'lanır ve yetkilendirme kararında
--                         kullanılmaz.
--   - absolute_expires_at: expires_at ile aynı değeri taşır (uyumluluk).
--
-- Eski migration'lar değiştirilmez; bu dosya tekrar çalıştırılabilir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. YENİ SÜTUNLAR
-- -----------------------------------------------------------------------------

alter table public.app_sessions
  add column if not exists renewed_at timestamptz not null default now(),
  add column if not exists rotated_at timestamptz not null default now(),
  add column if not exists previous_token_hash text,
  add column if not exists previous_token_valid_until timestamptz,
  add column if not exists device_label text not null default 'Bilinmeyen cihaz';

create index if not exists app_sessions_previous_token_hash_idx
  on public.app_sessions (previous_token_hash)
  where previous_token_hash is not null;

comment on column public.app_sessions.expires_at is
  'Kaydırmalı bitiş zamanı. Kullanıcı aktif oldukça (en fazla 24 saatte bir) ileri alınır.';
comment on column public.app_sessions.renewed_at is
  'Bitiş zamanının en son ileri alındığı an.';
comment on column public.app_sessions.rotated_at is
  'Oturum kimliğinin (token_hash) en son yenilendiği an.';
comment on column public.app_sessions.previous_token_hash is
  'Yenileme sonrası eski kimliğin özeti; previous_token_valid_until dolana kadar kabul edilir.';
comment on column public.app_sessions.device_label is
  'Kaba cihaz tanımı (tarayıcı · işletim sistemi). Ham User-Agent veya IP saklanmaz.';

-- -----------------------------------------------------------------------------
-- 2. ESKİ CİHAZ MODU KISITLARI KALDIRILIR
-- -----------------------------------------------------------------------------

-- "shared" oturumlarında hareketsizlik süresi zorunluydu; artık değil.
alter table public.app_sessions
  drop constraint if exists app_sessions_shared_needs_idle;

-- device_mode: kısıt ve NOT NULL kaldırılır, yalnızca eski veri için kalır.
alter table public.app_sessions
  drop constraint if exists app_sessions_device_mode_check;

alter table public.app_sessions
  alter column device_mode drop not null,
  alter column device_mode drop default;

comment on column public.app_sessions.device_mode is
  'DEPRECATED (0007): cihaz türü ayrımı kaldırıldı. Yeni oturumlarda null; iş mantığında kullanılmaz.';

-- -----------------------------------------------------------------------------
-- 3. MEVCUT OTURUMLARIN DÖNÜŞTÜRÜLMESİ
-- -----------------------------------------------------------------------------

-- Eski "ortak cihaz" oturumları zaten kalıcı olmayan çerezle açılmıştı ve
-- 8 saat içinde bitecekti; yeni modele taşınmaz, güvenli tarafta kalarak
-- iptal edilir. Kullanıcı bir kez yeniden giriş yapar ve kalıcı oturum alır.
update public.app_sessions
set revoked_at = coalesce(revoked_at, now())
where device_mode = 'shared';

-- Kişisel cihaz oturumları yeni modele taşınır: hareketsizlik sınırı yok,
-- bitiş zamanı kaydırmalı ömre çekilir.
update public.app_sessions
set idle_expires_at = null,
    expires_at = greatest(expires_at, now() + interval '180 days'),
    absolute_expires_at = greatest(absolute_expires_at, now() + interval '180 days'),
    renewed_at = now(),
    device_mode = null
where revoked_at is null;

comment on column public.app_sessions.idle_expires_at is
  'DEPRECATED (0007): hareketsizlik zaman aşımı kaldırıldı. Her zaman null; yetkilendirme kararında kullanılmaz.';
comment on column public.app_sessions.absolute_expires_at is
  'expires_at ile aynı değeri taşır (uyumluluk). Kaynak alan expires_at''tir.';

-- -----------------------------------------------------------------------------
-- 4. TEMİZLİK FONKSİYONU: hareketsizlik alanına bakmaz
-- -----------------------------------------------------------------------------

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
     or expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Yetkiler 0006'daki gibi: yalnızca service_role.
revoke all on function public.purge_expired_sessions() from public;
revoke all on function public.purge_expired_sessions() from anon;
revoke all on function public.purge_expired_sessions() from authenticated;
grant execute on function public.purge_expired_sessions() to service_role;
