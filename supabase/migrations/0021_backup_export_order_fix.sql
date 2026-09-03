-- =============================================================================
-- 0021 — YEDEK DIŞA AKTARIMI: SIRALAMA SÜTUNU DÜZELTMESİ
--
-- price_source_change_events tablosunda zaman sütununun adı `changed_at`;
-- `created_at` DEĞİL. 0020 bu tabloyu created_at ile sıralamaya çalışıyordu ve
-- yedek ucu 500 döndürüyordu.
--
-- Ders: sütun adları varsayılmadı, şemadan doğrulandı. Diğer tabloların
-- sıralama sütunları (profiles, portfolios, transactions, admin_audit_logs)
-- gerçekten created_at'tir ve değiştirilmedi.
-- =============================================================================

create or replace function public.backup_export_table(p_table text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  result jsonb;
begin
  -- İZİN VERİLEN TABLOLAR — beyaz liste. Listede olmayan hiçbir tablo okunamaz;
  -- p_table doğrudan sorguya GÖMÜLMEZ, her dal kendi sabit sorgusunu çalıştırır.
  case p_table

    when 'profiles' then
      -- password_hash ve kimlik sırları DIŞARIDA.
      select coalesce(jsonb_agg(to_jsonb(t) - 'password_hash'), '[]'::jsonb) into result
      from (
        select id, username, display_name, role, status, must_change_password,
               created_at, updated_at, last_login_at
        from public.profiles order by created_at
      ) t;

    when 'portfolios' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.portfolios order by created_at) t;

    when 'transactions' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.transactions order by created_at) t;

    when 'portfolio_positions' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.portfolio_positions) t;

    when 'user_preferences' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.user_preferences) t;

    when 'portfolio_price_preferences' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.portfolio_price_preferences) t;

    when 'price_source_change_events' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.price_source_change_events order by changed_at) t;

    when 'admin_audit_logs' then
      -- Denetim üst verisi: kim ne zaman ne yaptı. Sır içermez.
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.admin_audit_logs order by created_at) t;

    when 'price_mapping_approvals' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.price_mapping_approvals) t;

    when 'experimental_price_access' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (select * from public.experimental_price_access) t;

    when 'price_providers' then
      -- Yalnız yapılandırma üst verisi; kimlik/anahtar alanı taşınmaz.
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from (
        select code, display_name, license_status, enabled, user_selectable, is_default
        from public.price_providers order by code
      ) t;

    else
      raise exception 'Yedeklenemeyen tablo: %', p_table using errcode = 'P0004';
  end case;

  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.backup_export_table(text) from public, anon, authenticated;
grant execute on function public.backup_export_table(text) to service_role;

comment on function public.backup_export_table(text) is
  'Uygulama yedeği için beyaz listeli dışa aktarım. Parola hash''i, MFA secret''ı ve oturum token''ları ASLA dönmez.';
