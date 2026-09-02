-- =============================================================================
-- Altın Takip — bakım görevleri (pg_cron)
--
-- Bu dosya bir migration DEĞİLDİR. Supabase panelinde (SQL Editor) veya
-- `psql` ile, pg_cron uzantısı etkinleştirildikten sonra bir kez çalıştırılır.
-- Yeniden çalıştırmak güvenlidir: aynı isimli görev varsa önce kaldırılır,
-- pg_cron yoksa hiçbir şey yapmadan uyarı verir.
--
-- ÖNERİLEN SIKLIK
--   purge_expired_sessions()       her 15 dakikada bir  ('*/15 * * * *')
--     Süresi geçen oturumlar isteklerde zaten reddedilir; bu görev yalnızca
--     tabloyu küçük tutar. 15 dk, ortak cihaz hareketsizlik süresiyle uyumludur.
--   login_rate_limit_cleanup(60)   saatte bir           ('7 * * * *')
--     60 dakikadır dokunulmayan hız sınırı kayıtlarını siler. En uzun kilit
--     30 dk olduğu için 60 dk güvenli bir eşiktir.
--
-- DİKKAT: Bu dosyayı çalıştırmak görevleri "kurar"; çalıştığını doğrulamak
-- için `select * from cron.job_run_details order by start_time desc limit 20;`
-- sorgusuna bakın. Bu depo, görevlerin çalıştığını İDDİA ETMEZ.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron uzantısı kurulu değil. Supabase panelinden Database > Extensions > pg_cron etkinleştirin ve bu dosyayı yeniden çalıştırın.';
    return;
  end if;

  -- Aynı isimli görevler kaldırılır (idempotent kurulum, kopya görev yok).
  perform cron.unschedule(jobid)
    from cron.job
    where jobname in ('altin_purge_expired_sessions', 'altin_login_rate_limit_cleanup');

  perform cron.schedule(
    'altin_purge_expired_sessions',
    '*/15 * * * *',
    $job$ select public.purge_expired_sessions(); $job$
  );

  perform cron.schedule(
    'altin_login_rate_limit_cleanup',
    '7 * * * *',
    $job$ select public.login_rate_limit_cleanup(60); $job$
  );

  raise notice 'Altın Takip bakım görevleri kuruldu: altin_purge_expired_sessions (*/15), altin_login_rate_limit_cleanup (saatlik).';
end
$$;

-- Kurulumu görmek için:
--   select jobid, jobname, schedule, command, active from cron.job where jobname like 'altin_%';
