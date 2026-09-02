# Güvenlik

## 1. Tehdit modeli (bu sürüm)

| Tehdit | Karşı önlem |
| --- | --- |
| Yetkisiz hesap açma | Herkese açık kayıt ucu yok; hesapları yalnızca yönetici açar |
| Hesap keşfi (enumeration) | Giriş hatasında tek genel mesaj; kullanıcı/parola ayrımı yapılmaz |
| Kaba kuvvet parola denemesi | İstemci + kullanıcı bazlı hız sınırı, artan bekleme |
| Başka kullanıcının verisine erişim | Sunucu tarafı oturum sahipliği + Postgres RLS |
| Yetki yükseltme | Rol istemciden alınmaz; RLS tetikleyicisi rol/durum değişimini engeller |
| Anahtar sızıntısı | `service_role` yalnızca `server-only` modüllerde; testle denetlenir |
| Pasifleştirilen kullanıcının erişimi sürmesi | Oturumlar anında silinir; her istekte `status` yeniden okunur |
| Yönetici yetkisinin izlenememesi | `admin_audit_logs` ile değiştirilemez denetim kaydı |
| Siteler arası istek sahteciliği (CSRF) | Origin + Sec-Fetch-Site kontrolü ve imzalı senkronizasyon jetonu |
| Geçici parolayla uygulamayı kullanma | requireUsableUser guard'ı; UI yönlendirmesi tek önlem değildir |
| Ortak cihazda açık kalan oturum | Sunucu tarafında hareketsizlik (15 dk) ve mutlak (8 sa) süre |
| Çok örnekli dağıtımda hız sınırının bölünmesi | Postgres tabanlı paylaşımlı sayaç; üretimde zorunlu |
| Eşzamanlı isteklerle aşırı satış | Portföy satırı kilidiyle atomik Postgres RPC |

## 2. Parola custody'si

**Üretimde uygulama parola tutmaz.** Parolaların saklanması ve doğrulanması Supabase Auth'a aittir.

- Uygulama tablolarında `password`, `password_hash` veya geri çözülebilir bir alan **yoktur**
  (`tests/security-surface.test.ts` bunu SQL şeması üzerinde doğrular).
- `SupabaseAuthBackend` parolayı yalnızca Supabase'e iletir; hiçbir yerde saklamaz veya loglamaz.
- Yönetici mevcut parolayı **hiçbir uçtan göremez**; yalnızca yeni geçici parola atayabilir.
- Geçici parola oluşturulduğunda yöneticiye **bir kez** gösterilir, hiçbir yerde saklanmaz.

### 2.1 Kabul edilen ve sınırlandırılmış sapma: yerel geliştirme arka ucu

`src/server/auth/local-backend.ts`, Supabase yapılandırması olmadan uygulamanın uçtan uca
çalıştırılabilmesi ve test edilebilmesi için parolayı kendi deposunda `scrypt` ile hash'leyerek tutar.
Bu, "kendi parola hash sistemini yazma" kuralının bilinçli istisnasıdır ve şu sınırlarla korunur:

1. Yapıcı, `NODE_ENV=production` altında **hata fırlatır**; üretim derlemesinde kullanılamaz.
2. Depo dosyası `.data/` altındadır ve `.gitignore` ile dışlanmıştır; **asla commit edilmez**.
3. Supabase yapılandırması varsa bu arka uç hiç seçilmez.
4. `npm run admin:create` bu arka ucu kullandığında **açıkça "YEREL GELİŞTİRME HESABI"** yazar ve
   Supabase'de kullanıcı oluşturmadığını belirtir.
5. Yeni kod bu deseni örnek almaz (`CLAUDE.md` bunu kural olarak yazar).

#### Test kaçış kapısı

Tarayıcı testleri üretim derlemesine karşı koşar (böylece kullanıcıya gidecek kodun aynısı
doğrulanır). Supabase olmadan bunu yapabilmek için tek bir kaçış kapısı vardır:

```
AUTH_ALLOW_LOCAL_BACKEND=yalnizca-test-icin
```

- Değer **birebir** eşleşmezse (örn. `true`, `1`, `yes`) kapı açılmaz.
- Ayarlanmadığında üretim derlemesi Supabase yapılandırması ister ve yerel arka uç yapıcısında
  hata fırlatır.
- Üretim dağıtımlarında **asla** ayarlanmaz ve `.env.example` içinde yer almaz.
- `tests/device-mode.test.ts` → "yerel arka uç üretim koruması" bu davranışı doğrular.

Aynı belirteç, ortak cihaz hareketsizlik süresini testte kısaltmak için de gerekir
(`NEXT_PUBLIC_ALLOW_TEST_OVERRIDES`); o olmadan süre her zaman 15 dakikadır.

## 3. Kullanıcı adı → dahili kimlik

Supabase Auth parola girişi için bir e-posta kimliği ister. Kullanıcıdan e-posta istemediğimiz için
sunucuda deterministik bir dahili adres üretilir:

```
normalizeUsername(girdi) + "@" + AUTH_INTERNAL_EMAIL_DOMAIN
```

- Kullanıcı bu adresi **hiçbir ekranda görmez**; API yanıtlarında ve denetim kaydında yer almaz.
- Adrese e-posta gönderilmez. Varsayılan alan adı RFC 2606 ile ayrılmış `.invalid` uzantısını kullanır;
  operatör isterse kendi kontrolündeki bir alan adını verebilir.
- Normalizasyon büyük/küçük harf ve Türkçe karakter farklarını ortadan kaldırdığı için
  `Ayşe`, `AYSE` ve `ayse` **aynı** hesaba karşılık gelir; farklı hesap açılamaz.

## 4. Oturum yönetimi

- Oturum jetonu kriptografik olarak rastgele 32 bayttır; **yalnızca SHA-256 özeti** saklanır.
- Çerez: `httpOnly`, `sameSite=lax`, HTTPS üzerinde `secure`. Kişisel cihazda açık son
  kullanma tarihi verilir; şirket/ortak cihazda verilmez (tarayıcı kapanınca silinir).
- Her istekte profil yeniden okunur; `status !== 'active'` ise oturum reddedilir.
- Her istekte hem hareketsizlik hem mutlak süre SUNUCUDA denetlenir (bölüm 16).
- Oturumlar şu durumlarda topluca silinir:
  - kullanıcı kendi parolasını değiştirdiğinde,
  - yönetici parolayı sıfırladığında,
  - yönetici hesabı pasifleştirdiğinde,
  - hesap kalıcı olarak silindiğinde.

## 5. Hız sınırlama

`src/auth/rate-limit.ts` — kayan pencere + artan bekleme.

- Anahtar: `istemci IP | kullanıcı adı`
- Varsayılan: 15 dakikada 5 başarısız deneme → 60 sn bekleme, her ihlalde ikiye katlanır (en fazla 15 dk).
- Bekleme sırasında **doğru parola bile** kabul edilmez.

> **Üretimde sayaç Postgres'te paylaşılır.** Süreç belleğindeki uygulama yalnızca
> geliştirme/test içindir ve üretimde sessizce kullanılamaz. Ayrıntı: bölüm 18.

## 6. Satır düzeyi güvenlik (RLS)

Politikalar: [`supabase/migrations/0002_rls.sql`](../supabase/migrations/0002_rls.sql)
Davranış testleri: [`supabase/tests/rls.test.sql`](../supabase/tests/rls.test.sql) — `npm run test:db`

> **Önemli:** RLS, BFF içinden yapılan `service_role` sorgularında UYGULANMAZ.
> Burada tanımlı politikalar, Supabase Data API'ye kullanıcı JWT'siyle doğrudan
> erişim girişimlerine karşı **ikinci savunma katmanıdır**. Birincil sınır
> sunucu tarafı actor authorization'dır (bölüm 14).

| Tablo | Normal kullanıcı | Yönetici | Notlar |
| --- | --- | --- | --- |
| `profiles` | Yalnızca kendi satırını okur/günceller | Tümünü okur | Rol/durum/kullanıcı adı değişimi tetikleyici ile engellenir |
| `portfolios` | Kendi kayıtları (tam yetki) | Salt okunur | |
| `transactions` | Kendi kayıtları (tam yetki) | Salt okunur | Yönetici için yazma politikası **yok** |
| `user_preferences` | Kendi kaydı | — | |
| `admin_audit_logs` | Erişim yok | Salt okunur | UPDATE/DELETE politikası **yok** (değiştirilemez) |
| `app_sessions` | Erişim yok | Erişim yok | Yalnızca `service_role` |
| `gold_products`, `price_sources`, `current_prices` | Okuma | Okuma | Yazma yalnızca `service_role` |

Tüm tablolarda `enable row level security` **ve** `force row level security` açıktır; politika
tanımlanmayan tabloya hiçbir istemci erişemez.

### 6.1 Yetki yükseltmenin engellenmesi

`prevent_profile_privilege_escalation` tetikleyicisi, yönetici olmayan bir kullanıcı kendi profilinde
`role`, `status`, `username` veya `must_change_password` alanlarını değiştirmeye çalışırsa
`42501` hatasıyla işlemi durdurur. Bu, uygulama katmanı atlansa bile geçerlidir.

`is_admin()` ve `current_role_name()` fonksiyonları `SECURITY DEFINER` ve sabit `search_path` ile
tanımlanır; böylece politikaların içinde `profiles` okunurken RLS özyinelemesi oluşmaz.

## 7. `service_role` anahtarı

- Yalnızca `src/server/` altındaki `import "server-only"` işaretli modüller okur.
- `NEXT_PUBLIC_` öneki verilmesi yasaktır.
- `tests/security-surface.test.ts` şunları denetler:
  - anahtara referans veren her dosya `src/server/` altındadır ve `server-only` işaretlidir,
  - hiçbir istemci bileşeni (`"use client"`) `@/server/` modüllerini çalışma zamanında içe aktarmaz,
  - `@supabase/supabase-js` yalnızca sunucu modüllerinde kullanılır.
- `scripts/check-client-bundle.mjs`, üretim derlemesinden sonra istemci paketinde anahtar veya
  `service_role` izi olup olmadığını tarar (`npm run verify:bundle`).

## 8. Denetim kaydı (audit log)

Tablo: `admin_audit_logs`. Kaydedilen işlemler:

`user.create`, `user.deactivate`, `user.activate`, `user.password_reset`, `user.view`,
`user.portfolio_view`, `user.delete_attempt`, `user.delete`

Her kayıtta: yönetici kimliği ve kullanıcı adı, hedef kimliği ve kullanıcı adı, işlem türü,
başarı/başarısızlık, zaman damgası ve **hassas olmayan** metadata.

**Yazılmayanlar:** parola, parola özeti, geçici parola, tutar, birim fiyat, işlem detayı.
`tests/auth-service.test.ts` denetim kaydının bu değerleri içermediğini doğrular.

Kayıtlar değiştirilemez ve silinemez: `UPDATE`/`DELETE` politikası tanımlanmamıştır.

## 9. Kalıcı silme

- Varsayılan yönetim işlemi **pasifleştirmedir**; veriler korunur.
- Kalıcı silme, hedefin kullanıcı adının **birebir yazılmasını** zorunlu kılar.
- Silinecek portföy ve işlem sayısı onay ekranında gösterilir.
- Başarısız silme girişimi de (`user.delete_attempt`, `success: false`) denetim kaydına yazılır.
- Yönetici kendi hesabını silemez; son aktif yönetici silinemez.
- Silme, `auth.users` üzerinden yapılır; `ON DELETE CASCADE` ile profil, portföy, işlemler,
  tercihler ve oturumlar birlikte silinir. Denetim kayıtları korunur (yabancı anahtar yoktur).

## 10. İstemciden gelen veriye güven

- İşlem gövdeleri sunucuda `validateTransaction` ile **yeniden** doğrulanır
  (`src/server/transactions.ts`). İstemci doğrulaması yalnızca kullanıcı deneyimi içindir.
- Ürün birimi istemciden değil katalogdan alınır.
- Beklenmeyen hataların iç detayı istemciye dönmez; genel mesaj verilir, ayrıntı sunucuya loglanır.

## 11. Bilinen sınırlar

| Sınır | Etki | Plan |
| --- | --- | --- |
| Supabase ortamı olmadan SupabaseAuthBackend ve SQL yolları çalıştırılamadı | RPC'ler, tetikleyiciler ve RLS testleri gerçek veritabanında doğrulanmadı | Supabase projesi açıldığında `npm run test:db` ve entegrasyon testleri |
| CSP script-src satır içi koda izin verir | Next.js bootstrap script'i için gereklidir | Nonce tabanlı CSP (middleware ile) |
| purge_expired_sessions() otomatik çağrılmıyor | Süresi geçen satırlar birikir (erişim yine reddedilir) | pg_cron zamanlanmış görevi |

## 12. Şirket bilgisayarları ve ortak cihaz kullanımı

Uygulama **hiçbir yerel program kurulmadan** kullanılabilir: EXE, MSI, BAT, tarayıcı eklentisi
veya yerel yardımcı (native helper) yoktur. Bütün özellikler normal bir HTTPS web uygulaması
olarak çalışır. PWA kurulumu tamamen isteğe bağlıdır; hiçbir özellik kurulu olmaya bağlı değildir
ve kurulu PWA ile normal tarayıcı kullanımı arasında görsel veya işlevsel fark yoktur.
`tests/deployment-surface.test.ts` bu kısıtları depo üzerinde denetler.

### 12.1 Cihaz türü seçimi

Giriş ekranında iki seçenek vardır. **Güvenli varsayılan "Şirket / ortak cihaz"dır**; kalıcı
oturum yalnızca kullanıcı açıkça "Kişisel cihaz" seçtiğinde verilir. Sunucu da aynı kuralı
uygular: `deviceMode` değeri tam olarak `"personal"` değilse `"shared"` kabul edilir.

Cihaz türü oturum kaydında (`app_sessions.device_mode`) saklanır; istemciden gelen bir değere
sonradan güvenilmez.

### 12.2 Şirket / ortak cihaz kısıtları

| Kısıt | Uygulama |
| --- | --- |
| Kalıcı oturum yok | Oturum çerezine son kullanma tarihi verilmez; tarayıcı kapanınca silinir (`src/server/auth/cookies.ts`) |
| "Beni hatırla" yok | Giriş ekranında böyle bir seçenek bulunmaz |
| Token/portföy tarayıcı deposuna yazılmaz | `localStorage` ve `sessionStorage` uygulama kodunda hiç kullanılmaz; IndexedDB yalnızca geliştirme demo modundadır |
| Hassas yanıtlar önbelleğe alınmaz | Servis çalışanı `/api/*` isteklerini ve kimliği doğrulanmış SAYFA yanıtlarını **hiç** önbelleğe yazmaz |
| Servis çalışanı kaydedilmez | Ortak cihazda kayıt yapılmaz; varsa kaldırılır ve tüm önbellekler temizlenir (`src/components/device-guard.tsx`) |
| PWA kurulum çağrısı gösterilmez | `beforeinstallprompt` bastırılır; uygulama hiçbir yerde `prompt()` çağırmaz |
| Cihaz izni istenmez | Bildirim, push, konum veya kamera izni hiçbir kod yolunda talep edilmez |
| 15 dakika hareketsizlikte otomatik çıkış | `SHARED_DEVICE_IDLE_TIMEOUT_MS`; süre üretimde sabittir, yalnızca geliştirme/test ortamında kısaltılabilir |

Otomatik çıkışta sunucudaki oturum kaydı da silinir; kullanıcı `/giris?sebep=zaman-asimi`
adresine yönlendirilir ve nedeni ekranda açıkça yazılır.

### 12.3 Oturum jetonu

- Jeton **yalnızca** `HttpOnly` çerezde taşınır; JavaScript ile okunamaz (`document.cookie`
  istemci kodunda hiç kullanılmaz ve `e2e/device.spec.ts` bunu tarayıcıda doğrular).
- `Secure` bayrağı HTTPS üzerinde her zaman açıktır (yalnızca yerel http geliştirmede kapalıdır).
- `SameSite=Lax` ile siteler arası isteklerde gönderilmez.
- Parola hiçbir zaman istemcide saklanmaz; giriş formu `method="post"` kullandığı ve düğme
  hidrasyon tamamlanana kadar kilitli olduğu için kimlik bilgileri adres çubuğuna da düşmez.

### 12.4 Veri konumu

Oturum açmış kullanıcının portföyü **bulut veritabanında** tutulur; cihazlar arası
senkronizasyon sunucu üzerinden yapılır (`ServerPortfolioRepository`). Cihazda kalıcı finansal
veri bırakılmaz. IndexedDB yalnızca geliştirme ortamındaki demo modunda kullanılır ve arayüzde
verinin senkronize olmadığı açıkça belirtilir.

## 14. Service-role ve RLS sınırı (NET AÇIKLAMA)

Bu ürün bir **BFF (Backend For Frontend)** mimarisi kullanır. Tarayıcı Supabase
Data API'ye doğrudan bağlanmaz; yalnızca bu uygulamanın API uçlarını çağırır.
Sunucu ise Supabase'e **`service_role` anahtarıyla** bağlanır.

> **`service_role` RLS'yi ATLAR.** BFF içinden yapılan sorgularda satır düzeyi
> güvenlik politikaları **UYGULANMAZ**. Bu bilinçli bir tasarım tercihidir ve
> aşağıdaki iki kural onu güvenli kılar.

**Birincil güvenlik sınırı: sunucu tarafı actor authorization.**
Hangi satırın kime ait olduğunu belirleyen tek gerçek mekanizma budur.

**RLS ikinci katmandır.** Kullanıcı JWT'siyle Supabase Data API'ye doğrudan
erişim denenirse (anon anahtar sızarsa, ileride istemci tarafı bir özellik
eklenirse veya bir yanlış yapılandırma olursa) RLS devreye girer. RLS'nin
gerçekten çalıştığı `supabase/tests/rls.test.sql` ile doğrulanır.

**Yanlış olurdu:** "Veriler RLS ile korunuyor." — BFF sorguları için bu ifade
DOĞRU DEĞİLDİR ve dokümanda bu şekilde geçmemelidir.

### 14.1 Actor tipleri ile derleme zamanı koruma

`src/server/auth/actor.ts` markalanmış (branded) tipler tanımlar:

| Tip | Nasıl üretilir | Ne işe yarar |
| --- | --- | --- |
| `UserActor` | `requireAuthenticatedUser` / `requireUsableUser` | Kullanıcının kendisi |
| `AdminActor` | `requireCurrentAdmin` | Yönetici (rol veritabanından okunur) |
| `DataScope` | `ownScope(actor)` veya `adminScope(admin, targetId)` | Veri erişim kapsamı |

Arka ucun veri metotları artık `userId: string` DEĞİL, `DataScope` alır. Bu
sayede bir route gövdeden gelen bir kimliği veri metoduna geçiremez — bu bir
**derleme hatasıdır**. Normal kullanıcı route'ları `AdminActor` üretemediği için
`adminScope()` de çağıramaz.

Servis ayrımı:

| Servis | Aktör | Kapsam |
| --- | --- | --- |
| `AuthService` | — | Giriş, oturum, parola |
| `UserPortfolioService` | `UserActor` | YALNIZCA kullanıcının kendi verisi |
| `AdminService` | `AdminActor` | Başka kullanıcıyı hedefleyen işlemler + denetim kaydı |

`tests/authorization-matrix.test.ts` her API ucunun hangi guard'ı kullandığını
tablo hâlinde doğrular; yeni bir uç eklenirse tablo güncellenmeden test geçmez.

## 15. Geçici parola guard'ı

İki ayrı guard vardır:

| Guard | Geçici parolalı kullanıcı | Kullanıldığı uçlar |
| --- | --- | --- |
| `requireAuthenticatedUser` | **Geçer** | `/api/auth/session`, `/api/auth/logout`, `/api/auth/change-password` |
| `requireUsableUser` | **Geçemez** | Portföy, işlemler, ayarlar |
| `requireCurrentAdmin` | **Geçemez** | Tüm yönetim uçları |

Reddedilen istek `403` ve `code: "PASSWORD_CHANGE_REQUIRED"` döner. Arayüz
yönlendirmesi tek önlem DEĞİLDİR; sunucu bağımsız olarak reddeder.
Parola değiştikten sonra tüm oturumlar düşer ve kullanıcı yeniden giriş yapar.

## 16. Sunucu tarafı oturum süresi

| | Kişisel cihaz | Şirket / ortak cihaz |
| --- | --- | --- |
| Hareketsizlik | Yok | **15 dakika** |
| Mutlak süre | 14 gün | **8 saat** |
| Çerez | Kalıcı | Tarayıcı kapanınca silinir |

`app_sessions` tablosunda `device_mode`, `last_seen_at`, `idle_expires_at`,
`absolute_expires_at` ve `revoked_at` alanları tutulur. `resolveSession()` her
istekte **hem** hareketsizlik **hem** mutlak süreyi kontrol eder; süresi geçen
oturum reddedilir ve kaydı silinir.

- `last_seen_at` her istekte yazılmaz: en fazla 60 saniyede bir tazelenir.
- İstemcideki 15 dakikalık sayaç yalnızca kullanıcı deneyimi içindir; askıya
  alınmış sekme veya tarayıcı oturum geri yükleme senaryolarında bile
  **güvenlik sınırı sunucudadır** (`tests/session-expiry.test.ts`).
- `purge_expired_sessions()` SQL fonksiyonu zamanlanmış görevle çağrılabilir.

Üretimde çerez adı `__Host-` öneklidir: tarayıcı bu öneki yalnızca `Secure`,
`Path=/` ve `Domain` verilmemiş çerezlerde kabul eder; alt alan adından çerez
sabitleme saldırısını engeller.

## 17. CSRF ve same-origin koruması

Durum değiştiren her istek (`POST`, `PUT`, `PATCH`, `DELETE`) iki kontrolden geçer:

1. **Origin + Sec-Fetch-Site.** `Origin` beklenen origin ile birebir eşleşmeli;
   `Sec-Fetch-Site` yalnızca `same-origin` veya `none` olabilir. Alt alan adından
   gelen istek (`same-site`) de reddedilir.
2. **İmzalı senkronizasyon jetonu.** Sunucu rastgele bir değer üretir, HMAC ile
   imzalar ve `HttpOnly` çerezde saklar. Aynı ham değer sayfaya
   `<meta name="csrf-token">` olarak basılır; istemci onu `X-CSRF-Token`
   başlığında geri gönderir.

- Jeton `localStorage`/`sessionStorage`'a **yazılmaz**; çerez `HttpOnly` olduğu
  için `document.cookie` ile de okunamaz.
- Klasik double-submit'ten daha güçlüdür: saldırgan alt alan adından çerez yazsa
  bile geçerli **imza** üretemez.
- Giriş ucu da aynı kontrolden geçer ve ayrıca hız sınırına tabidir.
- Kontrolün unutulmasını engellemek için **tüm** route'lar `apiRoute()`
  sarmalayıcısını kullanır; `tests/authorization-matrix.test.ts` bunu denetler.

### 17.1 Güvenlik başlıkları

`next.config.ts` içinde tanımlıdır:

| Başlık | Değer |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | kamera, konum, mikrofon, ödeme vb. tamamen kapalı |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | **yalnızca üretimde** (HTTPS) |

CSP, Next.js'in satır içi bootstrap script'lerini bozmayacak biçimde yazılmıştır
(script-src için `unsafe-inline`; geliştirmede ayrıca `unsafe-eval` ve websocket).
Üretim derlemesi ve E2E testleriyle doğrulanır.

## 18. Dağıtık hız sınırlayıcı

| Ortam | Uygulama |
| --- | --- |
| Geliştirme/test | `MemoryLoginRateLimiter` (süreç belleği) |
| Üretim | `PostgresLoginRateLimiter` (paylaşımlı, atomik SQL) |

- Anahtar (`IP|kullanıcı adı`) **ham hâliyle saklanmaz**: `RATE_LIMIT_PEPPER` ile
  HMAC-SHA256 özeti tutulur.
- Sayaç güncellemesi `SELECT ... FOR UPDATE` ile atomiktir; çok örnekli
  dağıtımda birlikte çalışır.
- **Fail closed:** üretimde Supabase yapılandırması veya `RATE_LIMIT_PEPPER`
  eksikse bellek sınırlayıcısına sessizce DÜŞÜLMEZ; açık bir yapılandırma hatası
  verilir. Sınırlayıcı sorgusu hata verirse istek reddedilir, geçilmez.
- `login_rate_limit_cleanup()` eski sayaçları temizler.

## 19. Veritabanı bütünlüğü

`0005_security_hardening.sql` ile eklenenler:

| Kural | Nasıl |
| --- | --- |
| Kullanıcı başına tek portföy | `portfolios(user_id)` UNIQUE |
| İşlemin portföyü sahibiyle uyumlu | `transactions(portfolio_id, user_id)` composite foreign key |
| Birim ürün kataloğuyla uyumlu | `enforce_transaction_unit()` tetikleyicisi |
| Adet ürününde tam sayı miktar | Aynı tetikleyici |
| Aşırı satış engeli (eşzamanlı dâhil) | `lock_user_portfolio()` + `assert_no_oversell()` içeren atomik RPC'ler |

Yazma yolları `create_transaction_checked`, `update_transaction_checked` ve
`delete_transaction_checked` fonksiyonlarıdır. Her biri kullanıcının portföy
satırını kilitler, yazar ve **aynı transaction içinde** kronolojik bakiyeyi
doğrular; ihlal varsa `ALTIN_OVERSELL` hatasıyla geri alır. Bir alışın silinmesi
veya azaltılması sonraki satışları geçersiz kılıyorsa da engellenir.

Migration mevcut veriyle güvenle çalışır: kısıt eklemeden önce çakışan satırlar
sayılır ve varsa açık bir hata ile durdurulur.

## 20. Denetim kaydının değiştirilemezliği

- RLS'e ek olarak **tetikleyici** düzeyinde `UPDATE` ve `DELETE` engellenir
  (`reject_audit_mutation`). Bu kural `service_role` için de geçerlidir.
- Uygulamada denetim kaydı düzenleme veya silme ucu **yoktur**.
- Kayda parola, oturum jetonu, ham IP veya tam finansal içerik **yazılmaz**.
- Kullanıcı silme akışı dürüsttür: `user.delete_attempt` (başarılı/başarısız),
  `user.delete` (başarılı) ve arka uç hatası durumunda `user.delete` (başarısız)
  ayrı ayrı kaydedilir.
- Silme başarılı olduğu hâlde son denetim kaydı **yazılamazsa** bu gizlenmez:
  yanıtta `auditWriteFailed: true` döner ve sunucuya `ALTIN_AUDIT_WRITE_FAILURE`
  işaretiyle kritik log yazılır.


## 21. Secret yönetimi

- Depoya **yalnızca** `.env.example` girer ve içinde gerçek değer bulunmaz.
- `.gitignore` tüm `.env*` dosyalarını dışlar (`.env.example` hariç) ve `.data/` klasörünü kapsar.
- `npm run admin:create` parolayı ekrana yazdırmaz, kabuk geçmişine düşürmez ve loglamaz.
