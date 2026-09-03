-- =============================================================================
-- 0018 — EKRANDA GÖRÜNEN HAM SATIRLAR
--
-- "Kayseri Fiyatları" ekranı, Sarraf TV ekranındaki BÜTÜN satırları ham adıyla
-- göstermelidir. Bu, portföy değerlemesinden AYRI bir kavramdır: bir satırın
-- görünmesi, o fiyatın hesaba katıldığı anlamına GELMEZ.
--
-- Sağlayıcı başına TEK satır tutulur ve her gözlemde değiştirilir. Geçmiş
-- burada tutulmaz; fiyat geçmişi price_quote_history'dedir.
--
-- Ham satırlar hassas veri değildir: yalnız ekranda herkese görünen etiket ve
-- rakamlardır. Yine de istemciye kapalıdır ve RPC üzerinden okunur.
-- =============================================================================

create table if not exists public.price_screen_rows (
  provider_id uuid primary key references public.price_providers (id) on delete cascade,
  /**
   * Gözlemin tamamı: her satır için ham etiket, okunan değerler, çözüm durumu.
   * Şekil: [{ rawLabel, buy, sell, single, canonicalProductId, confidence,
   *           usedInValuation, reason }]
   */
  rows jsonb not null default '[]'::jsonb,
  /** Ekranın yapısal imzası; değişirse eşleme gözden geçirilmelidir. */
  screen_signature text not null default '',
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),

  constraint price_screen_rows_rows_is_array check (jsonb_typeof(rows) = 'array')
);

comment on table public.price_screen_rows is
  'Ekranda görünen son ham satır kümesi. Görünmek ile değerlemede kullanılmak AYRI kavramlardır.';

alter table public.price_screen_rows enable row level security;

-- İstemciye tamamen kapalı; yalnız RPC üzerinden okunur.
revoke all on public.price_screen_rows from public, anon, authenticated;
grant select on public.price_screen_rows to service_role;

-- -----------------------------------------------------------------------------
-- Yazma: yalnız alım yolundan (service_role RPC)
-- -----------------------------------------------------------------------------

create or replace function public.price_screen_rows_set(
  p_code text,
  p_rows jsonb,
  p_signature text,
  p_observed timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  select id into pid from public.price_providers where code = p_code;
  if pid is null then
    raise exception 'Bilinmeyen fiyat sağlayıcısı: %', p_code using errcode = 'P0004';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ham satır listesi dizi olmalıdır.' using errcode = 'P0004';
  end if;

  insert into public.price_screen_rows (provider_id, rows, screen_signature, observed_at, updated_at)
  values (pid, p_rows, coalesce(p_signature, ''), p_observed, now())
  on conflict (provider_id) do update set
    rows = excluded.rows,
    screen_signature = excluded.screen_signature,
    observed_at = excluded.observed_at,
    updated_at = now();

  return jsonb_build_object('providerCode', p_code, 'rowCount', jsonb_array_length(p_rows));
end;
$$;

revoke all on function public.price_screen_rows_set(text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.price_screen_rows_set(text, jsonb, text, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- Okuma: ekran için
-- -----------------------------------------------------------------------------

create or replace function public.price_screen_rows_get(p_code text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select case when r.provider_id is null then null else jsonb_build_object(
    'providerCode', p.code,
    'rows', r.rows,
    'screenSignature', r.screen_signature,
    'observedAt', r.observed_at,
    'updatedAt', r.updated_at
  ) end
  from public.price_providers p
  left join public.price_screen_rows r on r.provider_id = p.id
  where p.code = p_code;
$$;

revoke all on function public.price_screen_rows_get(text) from public, anon, authenticated;
grant execute on function public.price_screen_rows_get(text) to service_role;
