-- =============================================================================
-- 0024 — YÖNETİCİ PORTFÖY OKUMASI KALDIRILDI
--
-- ÜRÜN KARARI (sahibi verdi): yönetici kullanıcının altın varlığını GÖRMEZ.
-- Miktar, tutar, ortalama maliyet, kâr/zarar ve işlem geçmişi yönetici
-- yüzeyinden tamamen kaldırıldı; `/api/admin/users/[id]/portfolio` ucu silindi
-- ve `AdminService.getUserPortfolio` yerini yalnızca profil dönen
-- `getUserAccount` aldı.
--
-- Yönetici hesabın YAŞAM DÖNGÜSÜNÜ görmeye devam eder: son giriş zamanı, açık
-- oturumlar, cihaz etiketi. Destek için gereken budur.
--
-- BU MIGRATION yalnızca denetim eylemi listesine `user.account_view` ekler.
-- `user.portfolio_view` listeden ÇIKARILMAZ: geçmişte yazılmış kayıtlar
-- durur ve denetim kaydı değiştirilemezdir. Eski eylem artık ÜRETİLMEZ.
-- =============================================================================

alter table public.admin_audit_logs
  drop constraint if exists admin_audit_logs_action_check;

alter table public.admin_audit_logs
  add constraint admin_audit_logs_action_check check (
    action in (
      'user.create', 'user.deactivate', 'user.activate', 'user.password_reset',
      'user.view', 'user.portfolio_view', 'user.account_view',
      'user.sessions_view', 'user.sessions_revoke',
      'user.delete_attempt', 'user.delete',
      'mfa.enroll', 'mfa.verify', 'mfa.reset', 'mfa.recovery_used',
      'price.provider_update', 'price.source_change', 'price.refresh',
      'price.quarantine_view', 'price.default_source',
      -- Worker bir yönetici DEĞİLDİR: yazmalarının izi price_ingestion_runs'tadır,
      -- yönetici denetim kaydında değil.
      'price.experimental_access', 'price.mapping_approve',
      'data.export', 'data.deletion_request'
    )
  );

comment on constraint admin_audit_logs_action_check on public.admin_audit_logs is
  'Denetim eylemleri kapalı listedir. user.portfolio_view artık üretilmez ama '
  'geçmiş kayıtlar için listede kalır; denetim kaydı değiştirilemez.';
