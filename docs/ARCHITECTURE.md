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
│   └── auth/
│       ├── backend.ts        AuthBackend sözleşmesi
│       ├── supabase-backend.ts   Üretim uygulaması
│       ├── local-backend.ts      Geliştirme test ikizi
│       ├── service.ts        Yetkilendirme, denetim kaydı, iş kuralları
│       └── index.ts          Tekil örnekler, çerez ve oturum yardımcıları
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

### 3.3 Cihaz türü

Giriş isteğinde `deviceMode` alanı gönderilir. Sunucu yalnızca değer tam olarak `"personal"` ise
kişisel cihaz kabul eder; diğer her durumda `"shared"` (en kısıtlayıcı) uygulanır. Seçim oturum
kaydında (`app_sessions.device_mode`) saklanır ve sonradan istemciden değiştirilemez.

Kök yerleşim (`src/app/layout.tsx`) oturumdan cihaz türünü okur ve iki istemci bileşenine geçirir:

- `DeviceGuard` — ortak cihazda 15 dk hareketsizlik sayacı, servis çalışanı kaydının kaldırılması,
  önbelleklerin temizlenmesi ve PWA kurulum çağrısının bastırılması.
- `ServiceWorkerRegistrar` — yalnızca kişisel cihazda ve üretim derlemesinde kayıt yapar.

### 3.4 Oturum

Oturumu uygulama yönetir (`app_sessions` tablosu / yerel dosya). Bunun nedeni:

- Parola sıfırlama ve pasifleştirme işlemlerinde **tüm cihazlardaki oturumları anında düşürebilmek**.
- İki arka ucun (Supabase / yerel) tek bir davranışta buluşması, dolayısıyla tek yerden test edilebilmesi.

Her istekte oturum çözülürken profilin `status` alanı yeniden okunur; pasifleştirilen kullanıcının
mevcut oturumu ilk istekte geçersiz olur.

### 3.5 Yetkilendirme

- `requireCurrentUser()` — oturum zorunlu.
- `requireCurrentAdmin()` — oturum + veritabanındaki `role = 'admin'` kontrolü.
- Rol **istemciden alınmaz**. Panelden oluşturulan her hesap `user` rolündedir.
- `admin` rolü yalnızca `npm run admin:create` ile verilir.
- Arayüzdeki menü gizleme yalnızca sadelik içindir; güvenlik sunucuda ve RLS'de sağlanır.

## 4. Arka uç seçimi

```
Supabase URL + anon key + service_role key hepsi var mı?
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
| POST | `/api/auth/login` | Herkese açık |
| POST | `/api/auth/logout` | Herkese açık |
| GET | `/api/auth/session` | Herkese açık (oturum yoksa `null`) |
| POST | `/api/auth/change-password` | Oturum |
| GET / PATCH | `/api/portfolio` | Oturum (yalnızca kendi kaydı) |
| GET / POST / DELETE | `/api/transactions` | Oturum (yalnızca kendi kayıtları) |
| PUT / DELETE | `/api/transactions/[id]` | Oturum (yalnızca kendi kayıtları) |
| GET / POST | `/api/admin/users` | Yönetici |
| GET / PATCH / DELETE | `/api/admin/users/[id]` | Yönetici |
| POST | `/api/admin/users/[id]/password` | Yönetici |
| GET | `/api/admin/users/[id]/portfolio` | Yönetici (salt okunur) |
| GET | `/api/admin/audit` | Yönetici |

**Kayıt (register/signup) ucu bilinçli olarak yoktur** ve varlığı testle engellenir.

Tüm yanıtlar tek zarf kullanır: başarıda `{ data }`, hatada `{ error, code }`.

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
