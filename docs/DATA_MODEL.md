# Veri Modeli

Migration'lar: [`supabase/migrations/`](../supabase/migrations/) — sırayla `0001` → `0002` → `0003`.

## 1. İlişki şeması

```
auth.users (Supabase Auth — parolalar burada)
   │ 1:1  (ON DELETE CASCADE)
   ▼
profiles ──────┬──────────────┬──────────────┬─────────────────┐
   │ 1:N       │ 1:N          │ 1:N          │ 1:1             │
   ▼           ▼              ▼              ▼                 │
portfolios  transactions  app_sessions  user_preferences       │
   │ 1:N       ▲                                               │
   └───────────┘                                               │
                                                               │
gold_products ──< transactions                                 │
gold_products ──< current_prices >── price_sources             │
                                                               │
admin_audit_logs  (yabancı anahtar YOK — kullanıcı silinse de kayıt kalır)
```

## 2. `profiles`

Kullanıcı profili. **Parola bilgisi içermez.**

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `uuid` PK | `auth.users(id)` → `ON DELETE CASCADE` |
| `username` | `text` | Normalize edilmiş, küçük harf. **Büyük/küçük harfe duyarsız benzersiz** |
| `display_name` | `text` | 2–80 karakter |
| `role` | `text` | `admin` \| `user` |
| `status` | `text` | `active` \| `inactive` |
| `must_change_password` | `boolean` | `true` ise kullanıcı parolasını değiştirene kadar uygulamayı kullanamaz |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` tetikleyici ile güncellenir |
| `last_login_at` | `timestamptz` | |

Kısıtlar:

- `profiles_username_lowercase` — `username = lower(username)`
- `profiles_username_format` — `^[a-z][a-z0-9._-]{2,31}$`
- `profiles_role_check`, `profiles_status_check`, `profiles_display_name_length`

İndeksler: `profiles_username_lower_key` (UNIQUE, `lower(username)`), `profiles_role_idx`,
`profiles_status_idx`

## 3. `app_sessions`

Uygulamanın kendi oturum tablosu. Parola sıfırlama ve pasifleştirmede satırlar silinerek **tüm
cihazlardaki oturumlar** geçersiz kılınır.

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` | `profiles(id)` → `CASCADE` |
| `token_hash` | `text` UNIQUE | Jetonun kendisi değil, **SHA-256 özeti** |
| `expires_at` | `timestamptz` | |
| `created_at` | `timestamptz` | |

İndeksler: `app_sessions_user_id_idx`, `app_sessions_expires_at_idx`
RLS: politika **yok** — yalnızca `service_role` erişir.

## 4. `gold_products`

Altın ürün kataloğu. Tek kaynak `src/domain/catalog.ts`; SQL kopyası `npm run db:catalog` ile üretilir.

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `text` PK | Kalıcı kimlik, örn. `gram-altin` |
| `name` | `text` | Görünen ad |
| `category` | `text` | `gram` \| `kulce` \| `ziynet` \| `ayarli` |
| `unit` | `text` | `gram` \| `adet` |
| `milyem` | `numeric(5,4)` | Saflık, 0–1 |
| `gram_weight` | `numeric(10,4)` | Bir birimin brüt gramı |
| `pure_gold_per_unit` | `numeric(10,4)` | `milyem * gram_weight` |
| `sort_order` | `integer` | |
| `is_active` | `boolean` | |

## 5. `portfolios`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` | `profiles(id)` → `CASCADE` |
| `name` | `text` | Kullanıcının seçtiği portföy adı |
| `display_name` | `text` | Görünen ad (isteğe bağlı) |
| `created_at` / `updated_at` | `timestamptz` | |

İndeks: `portfolios_user_id_idx`

## 6. `transactions`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` | RLS'in ana filtre alanı, indeksli |
| `portfolio_id` | `uuid` | `portfolios(id)` → `CASCADE` |
| `product_id` | `text` | `gold_products(id)` |
| `side` | `text` | `buy` \| `sell` — yön burada tutulur |
| `quantity` | `numeric(18,6)` | **Her zaman pozitif** (`> 0` kısıtı) |
| `unit` | `text` | `gram` \| `adet` |
| `traded_at` | `date` | |
| `unit_price` | `numeric(18,2)` | `> 0` |
| `fee_amount` | `numeric(18,2)` | `>= 0`, işçilik/komisyon |
| `note` | `text` | En fazla 280 karakter |
| `created_at` / `updated_at` | `timestamptz` | |

İndeksler: `transactions_user_id_idx`, `transactions_portfolio_id_idx`,
`transactions_user_product_idx (user_id, product_id)`, `transactions_user_traded_at_idx (user_id, traded_at)`

## 7. `price_sources`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `text` PK | Örn. `mock` |
| `label` | `text` | Arayüzde gösterilen ad, örn. "Test Verisi" |
| `market` | `text` | Piyasa kimliği, örn. `TEST` |
| `is_real_market_data` | `boolean` | `false` ise arayüz **zorunlu olarak** test verisi uyarısı gösterir |
| `disclaimer` | `text` | Kullanıcıya gösterilen açıklama |
| `stale_after_seconds` | `integer` | Bu süreden eski veri "güncel" sayılmaz |
| `is_active` | `boolean` | |

## 8. `current_prices`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `source_id` + `product_id` | PK | Bileşik anahtar |
| `buy_price` | `numeric(18,2)` | Piyasanın **alış** fiyatı — kullanıcının bozdurma karşılığı |
| `sell_price` | `numeric(18,2)` | Piyasanın **satış** fiyatı — kullanıcının yeniden alım maliyeti |
| `currency` | `text` | Varsayılan `TRY` |
| `market` | `text` | |
| `provider_timestamp` | `timestamptz` | Sağlayıcının bildirdiği zaman |
| `fetched_at` | `timestamptz` | Verinin çekildiği zaman |
| `status` | `text` | `ok` \| `stale` \| `unavailable` |

Kısıt: `current_prices_spread_check` → **`buy_price <= sell_price`**.
Alış ve satışın ters kaydedilmesi veritabanı düzeyinde engellenir.

## 9. `user_preferences`

| Sütun | Tip |
| --- | --- |
| `user_id` | `uuid` PK → `profiles(id)` |
| `default_product_id` | `text` → `gold_products(id)` |
| `locale` | `text` (varsayılan `tr-TR`) |
| `currency` | `text` (varsayılan `TRY`) |
| `updated_at` | `timestamptz` |

## 10. `admin_audit_logs`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `admin_user_id` | `uuid` | Yabancı anahtar **yok**: yönetici silinse de kayıt kalır |
| `admin_username` | `text` | O andaki kullanıcı adı |
| `target_user_id` | `uuid` | Nullable |
| `target_username` | `text` | Nullable |
| `action` | `text` | Aşağıdaki listeyle kısıtlı |
| `success` | `boolean` | Başarısız girişimler de kaydedilir |
| `metadata` | `jsonb` | **Hassas veri içermez** |
| `created_at` | `timestamptz` | |

İzin verilen `action` değerleri: `user.create`, `user.deactivate`, `user.activate`,
`user.password_reset`, `user.view`, `user.portfolio_view`, `user.delete_attempt`, `user.delete`

İndeksler: `admin_audit_logs_admin_idx`, `admin_audit_logs_target_idx`,
`admin_audit_logs_created_idx (created_at desc)`

**Yazılmayanlar:** parola, parola özeti, tutar, birim fiyat, işlem detayı.

## 11. Silme davranışı

| İşlem | Sonuç |
| --- | --- |
| Pasifleştirme | `status = 'inactive'`, oturumlar silinir, **veriler korunur** |
| Kalıcı silme | `auth.users` satırı silinir → `profiles`, `portfolios`, `transactions`, `user_preferences`, `app_sessions` `CASCADE` ile silinir |
| Denetim kayıtları | Her iki durumda da **korunur** |

## 12. Hesaplama kuralları (uygulama katmanı)

- Maliyet yöntemi: ağırlıklı ortalama (kayan ortalama).
- Alış: `miktar × birim fiyat + işçilik` maliyete eklenir.
- Satış: `miktar × birim fiyat − işçilik` gelir; ortalama maliyet üzerinden gerçekleşmiş kâr/zarar yazılır.
- Bozdurma değeri = `kalan miktar × buy_price`
- Yeniden alım değeri = `kalan miktar × sell_price`
- Gerçekleşmemiş kâr/zarar = bozdurma değeri − kalan maliyet
- Fiyatı olmayan pozisyon **sıfır değil `null`** sayılır ve toplam değerlemeye dâhil edilmez;
  arayüz bunu ayrıca belirtir.
