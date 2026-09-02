# Mimari

## 1. Yığın

| Katman | Seçim | Neden |
| --- | --- | --- |
| Çatı | Next.js 16 (App Router) | Sunucu bileşenleri + API route'ları tek projede; PWA'ya uygun |
| Dil | TypeScript, `strict: true` | Finansal hesaplarda tip güvenliği |
| Arayüz | Tailwind CSS v4 + CSS değişkenleriyle tasarım sistemi | Az bağımlılık, açık/koyu tema tek kaynaktan |
| Kimlik | Supabase Auth (üretim) / yerel dosya deposu (geliştirme) | Parola custody'si dışarıda |
| Veri | Supabase Postgres + RLS | Kullanıcı izolasyonu veritabanı düzeyinde |
| Birim test | Vitest | Hızlı, yapılandırması hafif |
| Tarayıcı testi | Playwright (390/768/1440 px) | Gerçek responsive doğrulama |

Ek çalışma zamanı bağımlılıkları yalnızca: `@supabase/supabase-js`, `@supabase/ssr`, `server-only`.

## 2. Katmanlar

```
src/
├── config/          Ürün adı ve marka ayarları (tek kaynak)
├── domain/          Saf iş mantığı — çerçeveden ve depodan bağımsız
│   ├── catalog.ts       Altın ürün kataloğu (tek kaynak)
│   ├── portfolio.ts     Ortalama maliyet, değerleme, kâr/zarar
│   └── validation.ts    İşlem doğrulama kuralları
├── prices/          Fiyat sağlayıcı sözleşmesi + MockPriceProvider
├── storage/         Portföy deposu sözleşmesi (IndexedDB / sunucu / bellek)
├── auth/            Ortak kimlik kuralları (kullanıcı adı, parola, hız sınırı, tipler)
├── server/          YALNIZCA SUNUCU — "server-only" işaretli
│   ├── env.ts           Ortam değişkenleri ve arka uç seçimi
│   ├── http.ts          API yanıt zarfı ve hata eşlemesi
│   ├── security/
│   │   ├── csrf.ts           İmzalı CSRF jetonu + origin kontrolü
│   │   ├── config.ts         Çerez adları ve gizli anahtar (middleware ile ortak)
│   │   └── route.ts          apiRoute() merkezi sarmalayıcı
│   ├── rate-limit/
│   │   ├── types.ts          LoginRateLimiter sözleşmesi
│   │   ├── memory.ts         Geliştirme/test uygulaması
│   │   ├── postgres.ts       Üretim: paylaşımlı atomik sayaç
│   │   └── index.ts          Fail-closed seçim
│   ├── portfolio/
│   │   └── user-portfolio-service.ts   Kullanıcının KENDİ verisi (UserActor)
│   ├── admin/
│   │   └── admin-service.ts  Yönetim işlemleri (AdminActor) + denetim kaydı
│   └── auth/
│       ├── actor.ts          Markalanmış aktör/kapsam tipleri
│       ├── backend.ts        AuthBackend sözleşmesi (DataScope alır)
│       ├── supabase-backend.ts   Üretim uygulaması (atomik RPC'ler)
│       ├── local-backend.ts      Geliştirme test ikizi
│       ├── service.ts        Giriş, oturum, parola + guard'lar
│       └── index.ts          Tekil örnekler, çerez ve guard yardımcıları
├── proxy.ts         CSRF jetonu üretimi ve taşınması (Next 16 proxy kuralı)
├── state/           React bağlamı (portföy durumu)
├── components/      Arayüz bileşenleri
└── app/             Sayfalar ve API route'ları
```

**Bağımlılık yönü tek yönlüdür:** `app → components/state → domain/prices/storage`.
`domain` katmanı hiçbir çerçeve veya depo modülünü içe aktarmaz; bu yüzden saf birim testlerle
doğrulanabilir.

## 3. Kimlik doğrulama akışı

### 3.1 Kullanıcı adı → dahili kimlik eşlemesi

Supabase Auth'un parola girişi bir e-posta veya telefon kimliği ister. Ürün gereksinimi ise
kullanıcıdan bunları **istememektir**. Çözüm:

```
"Şükrü"  --normalizeUsername-->  "sukru"  --internalEmailForUsername-->  sukru@<AUTH_INTERNAL_EMAIL_DOMAIN>
```

- Eşleme **deterministiktir**: aynı kullanıcı adı her zaman aynı kimliği verir.
- Bu adres **hiçbir ekranda, API yanıtında veya denetim kaydında görünmez**; yalnızca sunucuda üretilir.
- Adrese e-posta gönderilmez; varsayılan alan adı RFC 2606 ile ayrılmış `.invalid` uzantısını kullanır.
- Uygulama: [`src/auth/internal-identity.ts`](../src/auth/internal-identity.ts)

### 3.2 Giriş

```
POST /api/auth/login  { username, password }
  → AuthService.login()
      1. Hız sınırı kontrolü        (istemci IP + kullanıcı adı)
      2. Kullanıcı adı doğrulama/normalizasyon
      3. backend.verifyCredentials()
           Supabase: geçici istemci ile signInWithPassword(dahili e-posta, parola),
                     ardından o geçici oturum kapatılır
           Yerel:    scrypt karşılaştırması (yalnızca geliştirme)
      4. status !== "active" ise giriş reddedilir (aynı genel mesajla)
      5. backend.createSession() → rastgele jeton; SHA-256 özeti saklanır
      6. httpOnly + sameSite=lax çerez yazılır
```

Kullanıcı yok, parola yanlış ve hesap pasif durumlarının hepsi **aynı** mesajı döndürür:
`Kullanıcı adı veya parola hatalı.`

### 3.3 Tek oturum modeli ve cihaz etiketi

Giriş isteğinde cihaz türü **gönderilmez**; her cihazda aynı kalıcı oturum verilir.
Sunucu yalnızca `User-Agent`'tan kaba bir etiket üretir (`describeDevice()` →
"Chrome · Windows") ve bunu `app_sessions.device_label` alanına yazar; ham
User-Agent veya IP saklanmaz. Etiket yönetici panelindeki oturum listesinde ve
"Tüm cihazlardan çıkış" akışında kullanıcıya yardımcı olur.

Uygulama yerleşimi (`src/app/(app)/layout.tsx`) oturumu çözer ve
`ServiceWorkerRegistrar`'ı yalnızca üretim derlemesinde kaydeder. İstemcide
hareketsizlik sayacı, otomatik çıkış veya cihaz türüne bağlı davranış **yoktur**.

### 3.4 Oturum

Oturumu uygulama yönetir (`app_sessions` tablosu / yerel dosya). Bunun nedeni:

- Parola sıfırlama, pasifleştirme ve yönetici iptalinde **tüm cihazlardaki oturumları anında düşürebilmek**;
  kullanıcının kendi "tüm cihazlardan çıkış" isteğini karşılayabilmek.
- Kaydırmalı ömür ve sessiz kimlik yenilemeyi (rotation) arka uçtan bağımsız uygulayabilmek.
- İki arka ucun (Supabase / yerel) tek bir davranışta buluşması, dolayısıyla tek yerden test edilebilmesi.

Her istekte oturum çözülürken profilin `status` alanı yeniden okunur; pasifleştirilen kullanıcının
mevcut oturumu ilk istekte geçersiz olur.

### 3.5 Yetkilendirme

- `requireCurrentUser()` — oturum zorunlu.
- `requireCurrentAdmin()` — oturum + veritabanındaki `role = 'admin'` kontrolü.
- Rol **istemciden alınmaz**. Panelden oluşturulan her hesap `user` rolündedir.
- `admin` rolü yalnızca `npm run admin:create` ile verilir.
- Arayüzdeki menü gizleme yalnızca sadelik içindir; güvenlik sunucuda sağlanır, RLS ve
  tablo grant'ları Data API'ye doğrudan erişime karşı ikinci katmandır.

## 3.6 Yetkilendirme sınırı (Sprint 0.5)

### Neden bu tasarım

Tarayıcı Supabase Data API'ye doğrudan bağlanmaz. Sunucu (BFF) Supabase'e
**`service_role` anahtarıyla** bağlanır ve bu anahtar **RLS'yi atlar**.
Dolayısıyla BFF içinden yapılan sorgularda satır düzeyi güvenlik uygulanmaz.

- **Birincil güvenlik sınırı:** sunucu tarafı actor authorization.
- **RLS:** Supabase Data API'ye kullanıcı JWT'siyle doğrudan erişim
  girişimlerine karşı **ikinci savunma katmanı**.

Bu ayrım `docs/SECURITY.md` bölüm 14'te ayrıntılı anlatılır ve dokümanın hiçbir
yerinde "veriler RLS ile korunuyor" gibi belirsiz bir ifade kullanılmaz.

### Markalanmış aktör tipleri

`src/server/auth/actor.ts`:

```
UserActor   <- requireAuthenticatedUser() / requireUsableUser()
AdminActor  <- requireCurrentAdmin()
DataScope   <- ownScope(userActor) | adminScope(adminActor, targetUserId)
```

Arka ucun veri metotları `userId: string` yerine `DataScope` alır:

```ts
listTransactions(scope: DataScope): Promise<Transaction[]>
createTransaction(scope: DataScope, input: TransactionInput): Promise<Transaction>
```

Bir route gövdeden gelen dizeyi `DataScope`'a dönüştüremez — bu bir derleme
hatasıdır. Normal kullanıcı route'ları `AdminActor` üretemediği için
`adminScope()` çağıramaz.

### Servis katmanı

| Servis | Dosya | Aktör | Kapsam |
| --- | --- | --- | --- |
| `AuthService` | `src/server/auth/service.ts` | — | Giriş, oturum, parola |
| `UserPortfolioService` | `src/server/portfolio/user-portfolio-service.ts` | `UserActor` | Yalnızca kendi verisi |
| `AdminService` | `src/server/admin/admin-service.ts` | `AdminActor` | Başka kullanıcı + denetim kaydı |

### Guard matrisi

| Uç | Guard |
| --- | --- |
| `POST /api/auth/login` | Herkese açık (origin + CSRF + hız sınırı) |
| `POST /api/auth/logout` | Herkese açık |
| `GET /api/auth/session` | Herkese açık |
| `POST /api/auth/change-password` | `requireAuthenticatedUser` (geçici parolalı geçer) |
| `/api/portfolio` | `requireUsableUser` |
| `/api/transactions`, `/api/transactions/[id]` | `requireUsableUser` |
| `/api/admin/**` | `requireCurrentAdmin` |

`tests/authorization-matrix.test.ts` bu tabloyu kaynak kod üzerinde doğrular.

## 3.7 Merkezi route sarmalayıcısı

Tüm API route'ları `apiRoute()` ile sarılır (`src/server/security/route.ts`):

1. Durum değiştiren isteklerde origin + CSRF doğrulaması.
2. `AppError` → HTTP yanıtı dönüşümü; beklenmeyen hataların iç detayı sızmaz.

Bir route'un bu kontrolü atlaması test tarafından engellenir.

## 3.8 Oturum yaşam döngüsü (tercihe bağlı: kalıcı / tarayıcı oturumu / admin)

Giriş gövdesindeki `keepSignedIn === true` ve rol, `sessionPolicyFor(role, keepSignedIn)` ile
politikaya çevrilir: kullanıcı + işaretli → kalıcı (aşağıdaki akış); kullanıcı + işaretsiz →
tarayıcı oturumu çerezi, 8 saat mutlak + 30 dk hareketsizlik (`idle_expires_at` ≤ 60 sn'de bir
ileri alınır, süre uzatılmaz, kimlik yenilenmez); admin → her zaman 8 saat + 15 dk, asla kalıcı
değil (kalıcı işaretli eski bir admin oturumu çözümlemede reddedilir).

```
login(username, password, clientKey, deviceLabel)
  → üç sayaçlı hız sınırı (ip / user / pair)
  → backend.createSession(userId, now, deviceLabel)   expires_at = now + 180 gün
  → kalıcı çerez (HttpOnly, Secure, SameSite=Lax, Path=/, __Host- öneki, expires=expires_at)

her istek (apiRoute → runWithSessionCache)
  → getSessionContext()  istekte bir kez çözülür (AsyncLocalStorage önbelleği)
  → backend.resolveSession(token, now)   iptal / bitiş / hesap durumu kontrolü
       eski kimlik (previous_token_hash) yalnızca 60 sn tolerans içinde kabul edilir
  → last_seen ≥ 15 dk eskiyse touchSession()     (tek yazma)
  → renewed_at ≥ 24 sa eskiyse expires_at = now + 180 gün (aynı yazma)
  → handler çalışır
  → commitSessionCookie(): rotated_at ≥ 7 gün ise yeni kimlik üretilir (rotateSession),
    süre uzatıldıysa veya kimlik yenilendiyse çerez tazelenir; çıkış uçları
    markSessionEnded() ile çerezin yeniden yazılmasını engeller
```

Sunucu bileşenleri (layout) çerez yazamadığı için yalnızca çözer; çerez tazeleme
bir sonraki API çağrısında yapılır. Sunucudaki bitiş zamanı güvenlik sınırıdır;
çerezin gecikmeli tazelenmesi yalnızca kullanıcı deneyimini ilgilendirir.

Oturumu kapatan olaylar: `logout` (yalnızca bu cihaz), `logout-all` (tüm
cihazlar), kullanıcının parola değişikliği (diğer cihazlar), yönetici parola
sıfırlama / pasifleştirme / oturum iptali / hesap silme (tüm cihazlar).

## 3.9 Kimlik doğrulama uçları

| Uç | Guard | Etki |
| --- | --- | --- |
| `POST /api/auth/login` | public | Oturum + kalıcı çerez |
| `GET /api/auth/session` | public | Kullanıcı ve `expiresAt` |
| `POST /api/auth/logout` | public | Yalnızca bu cihaz |
| `POST /api/auth/logout-all` | authenticated | Kullanıcının bütün oturumları |
| `POST /api/auth/change-password` | authenticated | Bu cihaz korunur, diğerleri kapanır |
| `GET/DELETE /api/admin/users/[id]/sessions` | admin | Oturum listesi / tümünü kapat |
| `DELETE /api/admin/users/[id]/sessions/[sessionId]` | admin | Tek oturumu kapat |

## 4. Arka uç seçimi

```
Supabase URL + anon key + SUPABASE_SECRET_KEY (veya eski SUPABASE_SERVICE_ROLE_KEY) hepsi var mı?
  evet → SupabaseAuthBackend
  hayır → üretim ortamı mı?
            evet → hata: yapılandırma eksik (sahte arka uçla çalışmaz)
            hayır → LocalAuthBackend (geliştirme test ikizi)
```

`LocalAuthBackend` `NODE_ENV=production` altında yapıcısında hata fırlatır. Tek istisna, tarayıcı
testlerinin üretim derlemesine karşı koşabilmesi için gereken açık kaçış kapısıdır
(`AUTH_ALLOW_LOCAL_BACKEND=yalnizca-test-icin`); değer birebir eşleşmezse kapı açılmaz.
Ayrıntı ve kabul edilen sapma: [SECURITY.md](SECURITY.md) bölüm 2.1.

## 5. API yüzeyi

| Yöntem | Yol | Yetki |
| --- | --- | --- |
| POST | `/api/auth/login` | Herkese açık (`keepSignedIn` tercihi) |
| POST | `/api/auth/logout` | Herkese açık (yalnızca bu cihaz) |
| POST | `/api/auth/logout-all` | Oturum (geçici parolalı da geçer) — bütün cihazlar |
| GET | `/api/auth/session` | Herkese açık (oturum yoksa `null`; `persistent` alanı) |
| POST | `/api/auth/change-password` | Oturum (geçici parolalı da geçer) |
| GET / PATCH | `/api/portfolio` | Kullanılabilir oturum (yalnızca kendi kaydı) |
| GET | `/api/portfolio/summary` | Kullanılabilir oturum — sunucu tarafı pozisyon + değerleme (salt okuma) |
| GET | `/api/transactions` | Kullanılabilir oturum — defter (ACTIVE/VOID/REPLACED) |
| POST | `/api/transactions` | Kullanılabilir oturum — OPENING_BALANCE / BUY / SELL ekle (idempotent) |
| DELETE | `/api/transactions` | Kullanılabilir oturum — tüm aktif kayıtları VOID yap |
| PUT | `/api/transactions/[id]` | Kullanılabilir oturum — düzelt (REPLACED + yeni kayıt) |
| DELETE | `/api/transactions/[id]` | Kullanılabilir oturum — iptal (VOID, sebep) |
| GET / POST | `/api/admin/users` | Yönetici |
| GET / PATCH / DELETE | `/api/admin/users/[id]` | Yönetici |
| POST | `/api/admin/users/[id]/password` | Yönetici |
| GET | `/api/admin/users/[id]/portfolio` | Yönetici (salt okunur; BUY/SELL/VOID/REPLACE yok) |
| GET / DELETE | `/api/admin/users/[id]/sessions` | Yönetici |
| DELETE | `/api/admin/users/[id]/sessions/[sessionId]` | Yönetici |
| GET | `/api/admin/audit` | Yönetici |

**Kayıt (register/signup) ucu bilinçli olarak yoktur** ve varlığı testle engellenir.

Tüm yanıtlar tek zarf kullanır: başarıda `{ data }`, hatada `{ error, code }`.
Durum değiştiren her uç origin + CSRF kontrolünden geçer (bkz. 3.7). Miktar ve tutar
alanları **ondalık dize** olarak taşınır; normal kullanıcı hiçbir uçta hedef `userId`
gönderemez.

## 6. Depolama soyutlaması

```ts
interface PortfolioRepository {
  kind: "indexeddb" | "memory" | "server";
  label: string;                 // Arayüzde gösterilen veri durumu
  syncsAcrossDevices: boolean;   // Kullanıcıya dürüstçe bildirilir
  getPortfolio / renamePortfolio
  listTransactions / createTransaction / updateTransaction / deleteTransaction / clearTransactions
}
```

- `ServerPortfolioRepository` — oturum açmış kullanıcı; API üzerinden, cihazlar arası senkron.
- `IndexedDbPortfolioRepository` — demo modu; yalnızca bu tarayıcı.
- `MemoryPortfolioRepository` — testler.

Arayüz bileşenleri yalnızca bu sözleşmeyi bilir; depolama değiştiğinde bileşenler değişmez.

## 7. Fiyat sağlayıcı soyutlaması

```ts
interface PriceProvider {
  meta: PriceProviderMeta;   // id, label, market, isRealMarketData, disclaimer, staleAfterMs
  getQuotes(productIds): Promise<PriceSnapshot>;
}
```

- `MockPriceProvider` — test verisi üretir, dış servise bağlanmaz.
- `LicensedPriceProvider` — ileride, lisanslı sağlayıcı sözleşmesiyle eklenecek.

Sağlayıcı başarısız olduğunda `status: "unavailable"` döner; **başka piyasaya geçilmez**.
`isRealMarketData: false` olan kaynak arayüzde her zaman "Test Verisi" olarak etiketlenir.

## 8. PWA

- **PWA kurulumu isteğe bağlıdır.** Hiçbir özellik kurulu olmaya veya servis çalışanına bağlı
  değildir; uygulama normal tarayıcı sekmesinde tam işlevlidir.
- `src/app/manifest.ts` — ad, kısa ad, standalone mod, tema renkleri, simgeler.
- `public/sw.js` — yalnızca statik varlık önbelleği. `/api/*` **ve kimliği doğrulanmış sayfa
  yanıtları** asla önbelleğe alınmaz.
- Güvenlik başlıkları (CSP, HSTS, Permissions-Policy vb.) `next.config.ts` içindedir.
- `src/app/cevrimdisi/page.tsx` — çevrimdışı yedek sayfa; fiyatların güncellenmediğini açıkça yazar.
- Servis çalışanı yalnızca üretim derlemesinde kaydedilir; geliştirmede eski kayıtlar temizlenir.
- Simgeler `npm run icons` ile koddan üretilir (fotoğraf veya dış kaynak yok).

## 9. Tasarım sistemi

Renkler, yarıçaplar ve gölgeler `src/app/globals.css` içinde CSS değişkenleri olarak tanımlanır ve
`@theme inline` ile Tailwind'e aktarılır. Uygulama **koyu temadır**; renk paleti tek bir `:root`
bloğunda tanımlıdır ve sistem ayarından bağımsız olarak uygulanır (`color-scheme: dark`).

- Tek vurgu rengi (altın) yalnızca marka, birincil eylem ve altın verisinde kullanılır.
- Kâr/zarar için ayrı semantik renkler; renk **tek** bilgi taşıyıcı değildir (işaret + yüzde de verilir).
- Rakamlar `font-variant-numeric: tabular-nums` ile hizalanır.
- Mobilde alt sekme çubuğu, masaüstünde yan gezinme.
- Fiyat kaynağı bilgisi panelin ortasında yer kaplamaz: en altta tek satırlık bir şerittir.
  Kaynağın adı, "gerçek piyasa verisi değil" uyarısı, piyasa, veri durumu ve son fiyat zamanı
  her zaman görünür; uzun yasal açıklama katlanmış (`<details>`) durur.
- `prefers-reduced-motion` desteklenir.

## 10. Veritabanı yetki sınırı (0006)

```
Tarayıcı ──(yalnızca /api/*)──▶ Next.js BFF ──(secret key, RLS atlanır)──▶ PostgreSQL
                                   │
                                   └─ actor authorization = birincil sınır

Tarayıcı ──(anon / authenticated JWT, Data API)──▶ PostgREST ──▶ PostgreSQL
                                   ├─ GRANT katmanı: INSERT/UPDATE/DELETE yok, kritik RPC yok
                                   └─ RLS katmanı : yalnızca kendi satırlarını SELECT
```

- Finansal mutation yalnızca `create/update/delete_transaction_checked` RPC'leri
  ile, yalnızca `service_role` tarafından yapılır.
- Varsayılan portföy profil oluşturulurken tetikleyiciyle hazırlanır; `GET`
  yolları veri oluşturmaz; onarım `provision_missing_defaults()` /
  `npm run admin:repair` ile idempotenttir.
- Doğrulama: `npm run test:db` (124 pgTAP, temiz DB'ye 0001→0010) ve
  `npm run test:data-api` (gerçek JWT ile PostgREST). Ayrıntı: SECURITY.md bölüm 22.

## 11. Muhasebe motoru (Sprint 1)

```
İstemci formu ──(LedgerCommand, ondalık dize, clientRequestId)──▶ /api/transactions
   │                                                                   │
   │  parseLedgerCommand (sıkı doğrulama)                              ▼
   │                                              UserPortfolioService.appendTransaction
   │                                                MARKET_BASELINE ise: sunucu fiyat sağlayıcısından
   │                                                anlık görüntü alır (istemci fiyatı YOK SAYILIR)
   │                                                                   ▼
   │                                              AuthBackend.appendLedgerEntry(scope, request)
   │                                                Supabase: ledger_append RPC (tek transaction:
   │                                                kilit → idempotency → ekle → rebuild → oversell)
   │                                                Yerel: aynı kurallar, kullanıcı başına kuyruk
   │                                                                   ▼
   ▼                                              { entry, position, replayed }
GET /api/portfolio/summary ──▶ positions_list + sunucu fiyatı ──▶ valuePositions (decimal)
```

- **Kaynak gerçek:** `public.transactions` (append-only). `portfolio_positions` yalnızca
  projeksiyondur; `ledger_rebuild_position` ile yeniden oluşturulur ve `service_role` bile
  doğrudan yazamaz.
- **Motor:** `src/domain/accounting/` — `decimal.ts` (decimal.js, sıkı girdi ayrıştırma),
  `amounts.ts` (alış/satış tutarları), `engine.ts` (yeniden oynatma, değerleme, etiketler),
  `commands.ts` (komut doğrulama). Aynı algoritma `0010_accounting_rpc.sql` içinde
  `ledger_replay_product` olarak vardır; `npm run accounting:verify` ikisini karşılaştırır.
- **İstemci:** özet (pozisyon + değerleme) hesap modunda SUNUCUDAN gelir; demo modunda aynı
  motor tarayıcıda çalışır (`src/storage/local-ledger.ts`). İstemci hiçbir sayıyı `Number`'a
  çevirerek hesaplamaz; biçimlendirme decimal ile yuvarlandıktan sonra yapılır.
- **İptal / düzeltme:** `DELETE /api/transactions/[id]` → `ledger_void` (VOID + sebep);
  `PUT` → `ledger_replace` (eski REPLACED, yeni kayıt, tek transaction).
- **Idempotency:** `clientRequestId` form ömrü boyunca sabittir; `(user_id, client_request_id)`
  benzersiz; aynı içerik → replay, farklı içerik → 409.
- Ayrıntı: [ACCOUNTING_MODEL.md](ACCOUNTING_MODEL.md).
