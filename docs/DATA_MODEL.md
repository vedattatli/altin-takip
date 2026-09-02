# Veri Modeli

Migration'lar: [`supabase/migrations/`](../supabase/migrations/) — sırayla
`0001` → `0002` → `0003` → `0004` → `0005` → `0006` → `0007` → `0008` → `0009` → `0010` → `0011`.
Yetki sınırı ve RLS testleri: [`supabase/tests/rls.test.sql`](../supabase/tests/rls.test.sql)
(156 pgTAP testi; `npm run test:db` temiz veritabanına tüm migration'ları uygulayıp koşar).
Muhasebe kuralları: [ACCOUNTING_MODEL.md](ACCOUNTING_MODEL.md).
Bakım görevleri: [`supabase/setup/maintenance-cron.sql`](../supabase/setup/maintenance-cron.sql).

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
admin_audit_logs   (yabancı anahtar YOK — kullanıcı silinse de kayıt kalır)
login_rate_limits  (yalnızca peppered HMAC özeti; kullanıcıya bağlı değildir)
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
| `expires_at` | `timestamptz` | **Kaydırmalı bitiş** (0007); `absolute_expires_at` aynı değeri taşır |
| `created_at` | `timestamptz` | |

`0005` ve `0007` ile eklenen alanlar için bkz. bölüm 13.1 ve 15.

İndeksler: `app_sessions_user_id_idx`, `app_sessions_expires_at_idx`,
`app_sessions_previous_token_hash_idx` (kısmi)
RLS: politika **yok**; `0006` ile anon/authenticated için SELECT grant'ı da yoktur —
yalnızca `service_role` erişir.

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

`0009` ile eklenen defter sütunları (transaction_kind, pricing_input_mode,
acquisition/disposal_unit_price, gross_amount, fees, workmanship, total_paid, net_proceeds,
cost_basis_origin, price_snapshot_id, status, voided_at, void_reason, replaces/replaced_by,
client_request_id, request_hash, ledger_sequence) için bkz. bölüm 17. `side`, `unit_price`,
`fee_amount` eski sütunlardır; uyumluluk için aynı değerleri taşır. `unit_price` artık `>= 0`.

İndeksler: `transactions_user_id_idx`, `transactions_portfolio_id_idx`,
`transactions_user_product_idx (user_id, product_id)`, `transactions_user_traded_at_idx (user_id, traded_at)`,
`transactions_client_request_idx (user_id, client_request_id) WHERE client_request_id IS NOT NULL`,
`transactions_ledger_order_idx (user_id, product_id, status, traded_at, created_at, ledger_sequence)`

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

## 12. Hesaplama kuralları

Bkz. [ACCOUNTING_MODEL.md](ACCOUNTING_MODEL.md): ürün bazlı hareketli ağırlıklı ortalama,
açılış bakiyesi kökenleri (ACTUAL / ESTIMATED / MARKET_BASELINE), alış-satış formülleri,
liquidation/replacement fiyat ayrımı, decimal ve yuvarlama politikası. Fiyatı olmayan pozisyon
**sıfır değil `null`** sayılır ve toplam değerlemeye dâhil edilmez.

## 13. Sprint 0.5 eklemeleri (`0005_security_hardening.sql`)

### 13.1 `app_sessions` — 0005 alanları (bir kısmı 0007 ile deprecated)

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `device_mode` | `text` | **DEPRECATED (0007):** nullable, kısıtsız; yeni oturumlarda `null`, iş mantığında kullanılmaz |
| `last_seen_at` | `timestamptz` | En fazla 15 dakikada bir güncellenir |
| `idle_expires_at` | `timestamptz` | **DEPRECATED (0007):** her zaman `null`; yetkilendirme kararında kullanılmaz |
| `absolute_expires_at` | `timestamptz` | `expires_at` ile aynı değeri taşır (uyumluluk) |
| `revoked_at` | `timestamptz` | Dolu ise oturum geçersiz |

- `app_sessions_shared_needs_idle` ve `app_sessions_device_mode_check` kısıtları
  0007 ile kaldırıldı.
- `purge_expired_sessions()` (0007 sürümü) iptal edilmiş ve `expires_at` geçmiş
  satırları siler; hareketsizlik alanına bakmaz.

### 13.2 Portföy ve işlem bütünlüğü

| Kısıt | Anlamı |
| --- | --- |
| `portfolios_user_id_key` UNIQUE(`user_id`) | Kullanıcı başına **tek** portföy |
| `portfolios_id_user_id_key` UNIQUE(`id`, `user_id`) | Composite FK için gerekli |
| `transactions_portfolio_owner_fkey` | `(portfolio_id, user_id)` → `portfolios(id, user_id)` |

Composite foreign key sayesinde bir işlemin `portfolio_id` ve `user_id` değerleri
**aynı sahibe** ait olmak zorundadır; başka kullanıcının portföyüne satır
eklenemez (veritabanı düzeyinde).

Migration mevcut veriyle güvenle çalışır: kısıt eklemeden önce çakışan satırlar
sayılır, varsa açık bir hata ile durdurulur ve hiçbir şey değiştirilmez.

### 13.3 Birim tutarlılığı

`enforce_transaction_unit()` tetikleyicisi her `INSERT`/`UPDATE` öncesi:

- `transactions.unit` değerinin `gold_products.unit` ile aynı olmasını,
- `adet` ile takip edilen üründe miktarın tam sayı olmasını

zorunlu kılar. Bilinmeyen `product_id` reddedilir.

### 13.4 Atomik işlem yazımı

| Fonksiyon | İş |
| --- | --- |
| `lock_user_portfolio(user_id)` | Portföy satırını `FOR UPDATE` ile kilitler; **yoksa oluşturmaz**, `ALTIN_PORTFOLIO_NOT_PROVISIONED` (P0002) verir (0006) |
| `assert_no_oversell(user_id, product_id)` | Kronolojik bakiyeyi doğrular; ihlalde `ALTIN_OVERSELL` |
| `create_transaction_checked(...)` | Kilitle → ekle → doğrula |
| `update_transaction_checked(...)` | Kilitle → güncelle → eski ve yeni ürünü doğrula |
| `delete_transaction_checked(...)` | Kilitle → sil → doğrula |

Kontrol ile yazma **aynı transaction** içindedir; iki eşzamanlı satış birlikte
eldeki miktarı aşamaz. İhlalde transaction geri alınır.

Bu fonksiyonlar yalnızca `service_role` tarafından çağrılabilir; `0006` yetkileri
tam imzayla ve her rolden (public, anon, authenticated) ayrı ayrı alır.

### 13.5 `login_rate_limits`

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `key_hash` | `text` PK | `HMAC-SHA256(IP\|kullanıcı adı, RATE_LIMIT_PEPPER)` |
| `failure_count` | `integer` | Pencere içindeki başarısız deneme |
| `window_started_at` | `timestamptz` | Kayan pencere başlangıcı |
| `lock_level` | `integer` | Artan bekleme seviyesi |
| `locked_until` | `timestamptz` | Bekleme bitiş zamanı |
| `updated_at` | `timestamptz` | Temizlik için |

**Ham IP veya kullanıcı adı saklanmaz.** RLS açıktır ve politika tanımlı
değildir: tabloya yalnızca `service_role` erişir.

Fonksiyonlar: `login_rate_limit_check`, `login_rate_limit_record_failure`
(satır kilidiyle atomik), `login_rate_limit_reset`, `login_rate_limit_cleanup`.

### 13.6 Denetim kaydı değiştirilemezliği

`reject_audit_mutation()` tetikleyicisi `admin_audit_logs` üzerinde `UPDATE` ve
`DELETE` işlemlerini `42501` hatasıyla reddeder. Bu kural RLS'ten bağımsızdır ve
`service_role` için de geçerlidir.

## 14. Veritabanı yetki sınırı (`0006_database_boundary.sql`)

### 14.1 Fonksiyon yetkileri

| Grup | Fonksiyonlar | Yetki |
| --- | --- | --- |
| Üst seviye BFF RPC'leri | `purge_expired_sessions()`, `create/update/delete_transaction_checked(...)`, `login_rate_limit_check/record_failure/reset/cleanup(...)`, `provision_missing_defaults()` | Yalnızca `service_role` EXECUTE |
| Dahili yardımcılar | `assert_no_oversell(uuid, text)`, `lock_user_portfolio(uuid)`, `provision_user_defaults(uuid)` | Hiçbir role açık değil |
| Tetikleyici fonksiyonları | `reject_audit_mutation()`, `enforce_transaction_unit()`, `touch_updated_at()`, `prevent_profile_privilege_escalation()`, `provision_user_defaults_trigger()` | Hiçbir role açık değil |
| RLS yardımcıları | `current_role_name()`, `is_admin()` | `authenticated` EXECUTE |

Varsayılan yetkiler: `postgres` rolünün global ve `public` şeması varsayılan
fonksiyon ACL'sinden PUBLIC/anon/authenticated kaldırılır (korumalı DO bloğu).

### 14.2 Tablo yetkileri

| Tablo | anon | authenticated | service_role |
| --- | --- | --- | --- |
| `profiles`, `portfolios`, `transactions`, `user_preferences` | — | SELECT | SELECT, INSERT, UPDATE, DELETE |
| `app_sessions`, `login_rate_limits` | — | — | SELECT, INSERT, UPDATE, DELETE |
| `admin_audit_logs` | — | SELECT | SELECT, INSERT |
| `gold_products`, `price_sources`, `current_prices` | — | SELECT | SELECT, INSERT, UPDATE, DELETE |

GRANT katmanı ("bu rol bu işlemi yapabilir mi?") ile RLS katmanı ("hangi
satırlar?") **ayrı ayrı** test edilir; GRANT reddi `permission denied for table`
mesajıyla, RLS reddi `row-level security policy` mesajıyla ayırt edilir.

### 14.3 Politika değişiklikleri

Kaldırılan: `portfolios_insert/update/delete_own`, `transactions_insert/update/delete_own`,
`user_preferences_all_own`, `profiles_update_self`.
Eklenen: `user_preferences_select_own`. `public` şemasında SELECT dışında politika yoktur.

### 14.4 Provisioning

| Nesne | İş |
| --- | --- |
| `provision_user_defaults(uuid)` | Portföy (`Portföyüm`) + tercih kaydı, `on conflict do nothing`; oluşturulan satır sayısını döner |
| `profiles_provision_defaults` (AFTER INSERT tetikleyicisi) | Profil ile birlikte aynı transaction içinde çalışır |
| `provision_missing_defaults()` | Eksik kaydı olan kullanıcıları tamamlar; `(user_id, created_rows)` döner; idempotent; yalnızca `service_role` |

Migration mevcut veriyi bir kez onarır ve tekrar çalıştırılabilir.

## 15. Kalıcı oturum modeli (`0007_persistent_sessions.sql`)

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `expires_at` | `timestamptz` | Kaydırmalı bitiş; aktivitede (≤ 24 saatte bir) `now() + 180 gün` |
| `renewed_at` | `timestamptz` | Bitişin en son ileri alındığı an |
| `rotated_at` | `timestamptz` | Oturum kimliğinin en son yenilendiği an (7 günde bir) |
| `previous_token_hash` | `text` | Yenileme sonrası eski kimliğin özeti (kısmi indeks) |
| `previous_token_valid_until` | `timestamptz` | Eski kimlik bu ana kadar (60 sn) kabul edilir |
| `device_label` | `text` | Kaba cihaz tanımı ("Chrome · Windows"); ham User-Agent / IP saklanmaz |

Dönüşüm: eski `shared` oturumlar iptal edilir (zaten kalıcı değildi), `personal`
oturumlar hareketsizlik sınırı olmadan kaydırmalı ömre taşınır; `device_mode`
null'lanır, kısıtları ve `idle_expires_at` kullanımı kaldırılır.

## 16. Oturum politikası (`0008_session_policy.sql`)

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `persistent` | `boolean` (default `true`) | "Oturumumu açık tut" tercihi. Mevcut kullanıcı oturumları kalıcı sayılır |
| `idle_expires_at` | `timestamptz` | Yeniden kullanımda: kalıcı olmayan oturumda hareketsizlik bitişi (kullanıcı 30 dk, admin 15 dk) |
| `absolute_expires_at` | `timestamptz` | Kalıcıda kaydırmalı bitişle aynı; kalıcı olmayanda giriş + 8 saat (uzatılmaz) |

Migration mevcut admin oturumlarını `persistent = false`, 8 saat / 15 dk sınırına çeker.
`purge_expired_sessions()` artık hareketsizliği dolan oturumları da siler.

## 17. Muhasebe şeması (`0009_portfolio_accounting.sql`)

### 17.1 `transactions` — defter sütunları

| Sütun | Tip | Notlar |
| --- | --- | --- |
| `transaction_kind` | `text` | `OPENING_BALANCE` \| `BUY` \| `SELL` |
| `pricing_input_mode` | `text` | `UNIT_PRICE` \| `TOTAL_AMOUNT` \| `MARKET_BASELINE` |
| `quoted_acquisition_unit_price` | `numeric(20,8)` | Kullanıcının UNIT_PRICE modunda GİRDİĞİ birim alış fiyatı (masraf hariç); TOTAL_AMOUNT'ta null; MARKET_BASELINE'da anlık görüntü bozdurma fiyatı (0011) |
| `effective_acquisition_unit_cost` | `numeric(20,8)` generated | `total_paid / quantity` — masraflar dâhil efektif birim maliyet (0011) |
| `quoted_disposal_unit_price` | `numeric(20,8)` | Girilen brüt birim satış fiyatı; TOTAL_AMOUNT'ta null (0011) |
| `effective_net_unit_proceeds` | `numeric(20,8)` generated | `net_proceeds / quantity` (0011) |
| `occurred_at` | `timestamptz` | İşlem anı: `(traded_at + (occurred_time ?? 00:00)) at time zone 'Europe/Istanbul'`; sıralama anahtarı (0011) |
| `occurred_time` | `time(0)` | Kullanıcının girdiği isteğe bağlı saat; null ise günün başlangıcı (0011) |
| `gross_amount`, `fees`, `workmanship` | `numeric(20,8)` | `>= 0` |
| `total_paid` | `numeric(20,8)` | BUY/OPENING: masraflar dâhil edinim maliyeti |
| `net_proceeds` | `numeric(20,8)` | SELL: masraflar düşülmüş net tahsilat |
| `cost_basis_origin` | `text` | `ACTUAL` \| `ESTIMATED` \| `MARKET_BASELINE` (baseline → `price_snapshot_id` zorunlu) |
| `status` | `text` | `ACTIVE` \| `VOID` \| `REPLACED`; `voided_at`, `void_reason` |
| `replaces_transaction_id` / `replaced_by_transaction_id` | `uuid` | Düzeltme ilişkisi |
| `created_by` | `uuid` | |
| `client_request_id`, `request_hash` | `text` | Idempotency: `(user_id, client_request_id)` benzersiz; içerik md5 ile karşılaştırılır |
| `ledger_sequence` | `bigint identity` | Deterministik sıra: `occurred_at`, `created_at`, `ledger_sequence`, `id` |

Tetikleyiciler `transactions_ledger_guard_update/delete`: finansal alanlar değiştirilemez;
yalnızca `ACTIVE → VOID/REPLACED` geçişi ve REPLACED kayda bir kez `replaced_by` yazımı;
hard delete yalnızca hesap cascade'inde. Eski kayıtlar `ACTUAL` / `UNIT_PRICE` olarak taşınır.

### 17.2 `price_snapshots`

`id`, `user_id`, `product_id`, `liquidation_price`, `replacement_price`, `provider`, `market`,
`currency`, `provider_status`, `is_real_market_data`, `provider_timestamp`, `fetched_at`,
`created_at`. RLS: kendi satırını SELECT. Grant: authenticated SELECT; service_role SELECT+INSERT;
UPDATE/DELETE hiçbir role (tetikleyici de reddeder).

### 17.3 `portfolio_positions` (türetilmiş projeksiyon)

`(portfolio_id, product_id)` PK, `user_id`, `quantity numeric(20,6)`, `remaining_cost_basis`,
`average_cost` (miktar 0 ise null), `realized_pnl`, `has_actual/estimated/baseline`
(ELDE KALAN miktarın kökeni; miktar sıfıra inince sıfırlanır), `realized_has_actual/estimated/baseline`
(gerçekleşmiş K/Z'nin tarihsel kökeni; silinmez — 0011), `active_transaction_count`,
`last_ledger_sequence`, `updated_at`. RLS: kendi satırını SELECT.
Grant: authenticated ve service_role yalnızca SELECT — yazma yalnızca SECURITY DEFINER RPC ile.
`npm run accounting:verify` defterden yeniden hesaplayıp karşılaştırır.

## 18. Muhasebe RPC'leri (`0010_accounting_rpc.sql`)

| Fonksiyon | Yetki | İş |
| --- | --- | --- |
| `ledger_append(uuid, jsonb)` | service_role | Kilit → idempotency → (MARKET_BASELINE ise snapshot) → tutar hesabı → INSERT → rebuild; `ALTIN_OVERSELL` (P0001), `ALTIN_IDEMPOTENCY_CONFLICT` (P0003), doğrulama (P0004) |
| `ledger_void(uuid, uuid, text)` | service_role | ACTIVE → VOID; rebuild; oversell olursa geri alır; `ALTIN_LEDGER_NOT_ACTIVE` (P0005) |
| `ledger_replace(uuid, uuid, jsonb)` | service_role | ACTIVE → REPLACED + yeni kayıt; iki ürünü de rebuild; tek transaction |
| `ledger_void_all(uuid, text)` | service_role | Tüm aktif kayıtları VOID |
| `ledger_list(uuid)`, `positions_list(uuid)` | service_role | JSON, sayılar kanonik metin |
| `ledger_verify(uuid)` | service_role | Yeniden oynatma ↔ projeksiyon karşılaştırması |
| `ledger_compute_amounts`, `ledger_replay_product`, `ledger_rebuild_position`, JSON yardımcıları | hiçbiri | Dahili |
| `create/update/delete_transaction_checked` (eski) | service_role | Yeni deftere yönlendirilir (uyumluluk) |

## 19. Muhasebe bütünlüğü (`0011_accounting_integrity.sql`)

| Değişiklik | Ayrıntı |
| --- | --- |
| Yetkiler | `service_role`'den `transactions` ve `price_snapshots` üzerindeki INSERT/UPDATE/DELETE kaldırıldı (yalnızca SELECT). Finansal yazma yalnızca SECURITY DEFINER RPC'lerle |
| Sütun yeniden adlandırma | `acquisition_unit_price → quoted_acquisition_unit_price`, `disposal_unit_price → quoted_disposal_unit_price` (guarded rename, idempotent) |
| Türetilmiş sütunlar | `effective_acquisition_unit_cost`, `effective_net_unit_proceeds` (`generated always ... stored`) |
| Zaman | `occurred_at timestamptz not null`, `occurred_time time(0)`; kısıtlar `transactions_occurred_date_consistent`, `transactions_occurred_time_consistent`; indeks `transactions_ledger_instant_idx` |
| Backfill | Yalnızca `occurred_at` boş satırlarda (ilk çalıştırma): quoted = UNIT_PRICE'ta `gross/quantity`, MARKET_BASELINE'da anlık görüntü fiyatı, TOTAL_AMOUNT'ta null; `occurred_at = traded_at 00:00 Europe/Istanbul`. Guard tetikleyicisi bu adım için geçici kapatılır |
| Kısıtlar | `transactions_quoted_prices_kind`; `price_snapshots_spread_consistent`, `price_snapshots_currency_try`, `price_snapshots_provider_market_nonempty` (mevcut veri önce denetlenir; çakışma varsa migration açık hatayla durur) |
| Projeksiyon | `realized_has_actual/estimated/baseline`; bütün pozisyonlar `ledger_rebuild_position` ile yeniden oluşturulur |
| RPC | `ledger_append` sıkı tarih/saat + anlık görüntü doğrulaması; `ledger_replay_product` iki köken kümesi ve `occurred_at` sırası; `ledger_verify` köken bayraklarını da karşılaştırır; JSON yardımcıları yeni alanları döner |
