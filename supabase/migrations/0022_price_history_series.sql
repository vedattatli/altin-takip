-- =============================================================================
-- 0022 — FİYAT GEÇMİŞİ SERİSİ (portföy değeri grafiği için)
--
-- Grafik uydurma veri ÜRETMEZ. `price_quote_history` zaten append-only olarak
-- kabul edilmiş her fiyatı zaman damgasıyla saklıyor; bu RPC yalnızca o
-- kayıtları okur. Nokta sıklığı, fiyatın toplanma sıklığıdır — arası
-- doldurulmaz, düzleştirilmez, ortalaması alınmaz.
--
-- NEDEN AYRI BİR RPC
-- BFF service_role ile bağlanır ve Data API üzerinden tabloya doğrudan erişim
-- kapalıdır (0006). Okuma yalnızca açıkça yetkilendirilmiş RPC'den yapılır.
--
-- KULLANICI VERİSİ İÇERMEZ
-- Fiyat geçmişi kullanıcıya değil sağlayıcıya aittir; bu yüzden burada
-- user_id / portfolio_id filtresi YOKTUR. Portföy değeri, kullanıcının kendi
-- defteriyle SUNUCUDA birleştirilir (bkz. portfolio-history-service).
-- =============================================================================

create or replace function public.price_quotes_history(
  p_codes text[],
  p_since timestamptz,
  p_limit integer default 5000
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(row_json order by observed_at, canonical_product_id), '[]'::jsonb)
  from (
    select
      h.fetched_at as observed_at,
      h.canonical_product_id,
      jsonb_build_object(
        'providerCode', p.code,
        'marketId', h.market_id,
        'canonicalProductId', h.canonical_product_id,
        'liquidationPrice', h.liquidation_price::text,
        'replacementPrice', h.replacement_price::text,
        'currency', h.currency,
        'observedAt', h.fetched_at,
        'providerTimestamp', h.provider_timestamp,
        'status', h.status
      ) as row_json
    from public.price_quote_history h
    join public.price_providers p on p.id = h.provider_id
    where p.code = any(p_codes)
      and h.fetched_at >= p_since
      and h.status = 'ok'
    -- En yeni kayıtlar önce alınır ki sınır aşıldığında GEÇMİŞ değil, en eski
    -- uç kırpılsın; grafik her zaman "şu ana kadar" doğru olsun.
    order by h.fetched_at desc
    limit greatest(1, least(coalesce(p_limit, 5000), 20000))
  ) as recent;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.price_quotes_history(text[], timestamptz, integer)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('revoke all on function %s from service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Aralık sorgusu için indeks: (fetched_at) üzerinden tarama yapılır.
create index if not exists price_quote_history_fetched_at_idx
  on public.price_quote_history (fetched_at desc);
