-- =============================================================================
-- Altın Takip — 0004 Oturum cihaz türü
--
-- "shared" (şirket / ortak cihaz) oturumlarında çerez kalıcı DEĞİLDİR ve
-- istemci tarafında 15 dakika hareketsizlikte otomatik çıkış uygulanır.
-- Bilinmeyen değer gelirse uygulama en kısıtlayıcı modu ("shared") varsayar.
-- =============================================================================

alter table public.app_sessions
  add column if not exists device_mode text not null default 'shared';

alter table public.app_sessions
  drop constraint if exists app_sessions_device_mode_check;

alter table public.app_sessions
  add constraint app_sessions_device_mode_check
  check (device_mode in ('personal', 'shared'));

comment on column public.app_sessions.device_mode is
  'Oturumun açıldığı cihaz türü. shared = ortak cihaz: kalıcı olmayan çerez ve otomatik çıkış.';
