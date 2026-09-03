# Güvenlik

## 1. Tehdit modeli (bu sürüm)

| Tehdit | Karşı önlem |
| --- | --- |
| Yetkisiz hesap açma | Herkese açık kayıt ucu yok; hesapları yalnızca yönetici açar |
| Hesap keşfi (enumeration) | Giriş hatasında tek genel mesaj; kullanıcı/parola ayrımı yapılmaz |
| Kaba kuvvet parola denemesi | IP, kullanıcı adı ve IP+kullanıcı adı için üç ayrı sayaç; artan bekleme |
| Başka kullanıcının verisine erişim | Sunucu tarafı oturum sahipliği + Postgres RLS |
| Yetki yükseltme | Rol istemciden alınmaz; RLS tetikleyicisi rol/durum değişimini engeller |
| Anahtar sızıntısı | `service_role` yalnızca `server-only` modüllerde; testle denetlenir |
| Pasifleştirilen kullanıcının erişimi sürmesi | Oturumlar anında silinir; her istekte `status` yeniden okunur |
| Yönetici yetkisinin izlenememesi | `admin_audit_logs` ile değiştirilemez denetim kaydı |
| Siteler arası istek sahteciliği (CSRF) | Origin + Sec-Fetch-Site kontrolü ve imzalı senkronizasyon jetonu |
| Geçici parolayla uygulamayı kullanma | requireUsableUser guard'ı; UI yönlendirmesi tek önlem değildir |
| Çalınan veya eski oturum kimliği | Kimlik 7 günde bir sessizce yenilenir; iptal/silme anında geçerliliği bitirir; kaydırmalı ömür 180 gün |
| BFF atlanarak Data API'ye doğrudan yazma | anon/authenticated için INSERT/UPDATE/DELETE grant'ı yok; kritik RPC'ler yalnızca `service_role` (0006) |
| Sahte `X-Forwarded-For` ile hız sınırı atlatma | Başlık yalnızca güvenilir vekilde (`TRUSTED_PROXY_PROVIDER`) okunur; üç ayrı sayaç |
| `Host` başlığıyla origin sahteciliği | Üretimde `APP_ORIGIN` zorunlu; başlıktan türetme yok (fail closed) |
| Çok örnekli dağıtımda hız sınırının bölünmesi | Postgres tabanlı paylaşımlı sayaç; üretimde zorunlu |
| Eşzamanlı isteklerle aşırı satış | Portföy satırı + ürün advisory kilidiyle atomik Postgres RPC; her mutation defteri yeniden oynatır |
| Çift tıklama / mobil ağ yeniden denemesi | `clientRequestId` idempotency: aynı içerik replay, farklı içerik 409 |
| Pozisyon projeksiyonunun elle değiştirilmesi | `portfolio_positions`'a service_role bile yazamaz; yalnızca RPC yeniden oluşturur |
| Sahte başlangıç fiyatı (MARKET_BASELINE) | İstemci fiyatı yok sayılır; sunucu sağlayıcısından alınır, anlık görüntü doğrulanır (makas/zaman/para birimi/ürün) ve değiştirilemez |
| RPC dışı doğrudan tablo yazımı (yanlış sunucu kodu) | `service_role` `transactions` / `price_snapshots` / `portfolio_positions` tablolarına yazamaz; yalnızca SECURITY DEFINER RPC (0011) |
| Sürüm sinyalinin elle değiştirilmesi | `portfolios.ledger_revision` tetikleyiciyle korunur; yalnızca defter RPC'leri artırır (0012) |
| Sayısal taşma (çok küçük miktar × büyük tutar) | Tutarlar, türetilmiş birim değerler ve birikimli pozisyon 12 tam basamakla sınırlı; TS ve SQL'de P0004 → 400 |
| Kontrolsüz cast (22P02 → 500) | Sayısal/UUID alanlar sıkı desenle ayrıştırılır; BFF geçersiz kimlik biçimini 404'e çevirir |
| Staging secret sızıntısı | `.env.staging.local` ve `.staging/` gitignore + paket dışı; betikler değer yazdırmaz; NEXT_PUBLIC_ taraması |
| Finansal kaydın sessizce silinmesi/değiştirilmesi | Defter append-only; hard delete ve finansal alan güncellemesi tetikleyiciyle reddedilir |
| Uzun ömürlü admin oturumu | Admin için tercihten bağımsız 8 saat / 15 dk; kalıcı işaretli admin oturumu reddedilir |

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
- `tests/session-cookie.test.ts` → "yerel arka uç üretim koruması" bu davranışı doğrular.

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

## 4. Oturum yönetimi ("Bu cihazda oturumumu açık tut")

Kalıcı oturum kullanıcı tercihine bağlıdır. Giriş ekranındaki tek kutu:

| | Çerez | Sunucu sınırı |
| --- | --- | --- |
| İşaretli | kalıcı `__Host-` çerez | 180 gün kaydırmalı, ≤ 24 saatte bir yenileme, 7 günde bir kimlik yenileme |
| İşaretsiz (varsayılan) | tarayıcı oturumu çerezi (kapanınca silinir) | 8 saat mutlak, 30 dk hareketsizlik (`idle_expires_at`, ≤ 60 sn'de bir yazılır) |
| Admin | her zaman tarayıcı oturumu çerezi | tercihten bağımsız 8 saat mutlak, 15 dk hareketsizlik; asla kalıcı değil |

Tercih tarayıcı deposuna yazılmaz; oturum kaydındaki `persistent` alanında tutulur (`0008`).
Mevcut 180 günlük kullanıcı oturumları kalıcı sayılır ve geçersiz kılınmaz; mevcut admin
oturumları migration ile güvenli sınıra çekilir. Aşağıdaki maddeler kalıcı (işaretli) oturumu
anlatır; kalıcı olmayan oturumda süre uzatma ve kimlik yenileme yoktur.

- Oturum kimliği kriptografik olarak rastgele 32 bayttır; **yalnızca SHA-256
  özeti** saklanır. Tarayıcıda yalnızca bu opak kimlik bulunur.
- Çerez: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Domain` verilmez, HTTPS üzerinde
  `Secure`, üretimde `__Host-` önekli. **Kalıcıdır**: son kullanma tarihi
  oturumun sunucudaki bitiş zamanıdır.
- **Kaydırmalı ömür:** 180 gün. Geçerli kullanıcı aktivitesinde bitiş zamanı
  sessizce ileri alınır; veritabanına en fazla 24 saatte bir yazılır
  (`SESSION_RENEWAL_INTERVAL_MS`). Aktif kullanıcı süresiz oturumda kalır.
- **Kimlik yenileme (rotation):** oturum kimliği 7 günde bir sessizce yenilenir;
  eski kimlik 60 saniyelik tolerans süresi boyunca (uçuştaki istekler için)
  kabul edilir, sonra reddedilir. Hiç bitmeyen ve hiç değişmeyen jeton yoktur.
- Çerez tazeleme yalnızca route handler'larda yapılır (`apiRoute()` istek sonunda
  `commitSessionCookie`); sunucu süresi zaten uzatıldığı için gecikme güvenlik
  sınırını etkilemez.
- Her istekte profil yeniden okunur; `status !== 'active'` ise oturum reddedilir.
- **Kalıcı oturumda hareketsizlik zaman aşımı YOKTUR.** 15 dakika, 1 saat veya 24 saat
  hareketsizlik, sayfa yenileme, tarayıcı/PWA kapatıp açma veya cihazı yeniden
  başlatma oturumu sonlandırmaz. Tarayıcı oturumunda (işaretsiz) ve admin oturumunda
  hareketsizlik ve mutlak sınırlar SUNUCUDA uygulanır; istemcide sayaç yoktur.

Oturumun zorunlu olarak sonlandığı durumlar:

| Olay | Etki |
| --- | --- |
| Kullanıcı "Çıkış" | Yalnızca bu cihazın oturum kaydı ve çerezi silinir |
| Kullanıcı "Tüm cihazlardan çıkış yap" (Ayarlar) | Kullanıcının bütün oturum kayıtları iptal edilir |
| Kullanıcı kendi parolasını değiştirir | **Diğer** cihazlar kapanır; bu cihaz devam eder |
| Yönetici parolayı sıfırlar | Bütün oturumlar kapanır |
| Yönetici hesabı pasifleştirir | Bütün oturumlar anında geçersiz olur |
| Yönetici belirli bir oturumu / tümünü iptal eder | İlgili oturum(lar) kapanır (denetim kaydı: `user.sessions_revoke`) |
| Hesap silinir | Bütün oturumlar kapanır |

Silinmiş, iptal edilmiş veya süresi dolmuş oturum kimliği hiçbir istekte kabul
edilmez (`tests/persistent-session.test.ts`, `e2e/session.spec.ts`).

Oturum kaydında yalnızca güvenli metadata tutulur: kaba cihaz etiketi
("Chrome · Windows"), oluşturulma, son görülme ve bitiş zamanı. **Ham IP veya
User-Agent saklanmaz.**

## 5. Hız sınırlama

`src/auth/rate-limit.ts` — kayan pencere + artan bekleme. Giriş denemesi **üç ayrı
sayaçtan** geçer; herhangi biri kilitliyse istek reddedilir:

| Sayaç | Anahtar | Varsayılan |
| --- | --- | --- |
| IP | `ip:<istemci>` | 15 dakikada 20 başarısız deneme (kilit en fazla 30 dk) |
| Kullanıcı adı | `user:<ad>` | 15 dakikada 10 başarısız deneme |
| Kombinasyon | `pair:<istemci>\|<ad>` | 15 dakikada 5 başarısız deneme → 60 sn bekleme, her ihlalde ikiye katlanır (en fazla 15 dk) |

- Tek sayaç iki saldırıyı kaçırırdı: aynı IP'den çok sayıda kullanıcı adı
  (credential stuffing) ve bir kullanıcı adını çok sayıda IP'den denemek.
- Başarılı girişte **yalnızca kombinasyon** sayacı sıfırlanır; IP ve kullanıcı
  adı sayaçları saldırı korumasını sürdürür.
- Bekleme sırasında **doğru parola bile** kabul edilmez.
- Anahtarlar `RATE_LIMIT_PEPPER` ile HMAC'lenir; ham IP veya kullanıcı adı
  saklanmaz. İstemci IP'si yalnızca güvenilir vekilde başlıktan okunur (bölüm 23).

> **Üretimde sayaç Postgres'te paylaşılır.** Süreç belleğindeki uygulama yalnızca
> geliştirme/test içindir ve üretimde sessizce kullanılamaz. Ayrıntı: bölüm 18.

## 6. Satır düzeyi güvenlik (RLS) ve tablo yetkileri

Politikalar: [`supabase/migrations/0002_rls.sql`](../supabase/migrations/0002_rls.sql)
(yazma politikaları `0006` ile kaldırıldı)
Grant'lar: [`supabase/migrations/0006_database_boundary.sql`](../supabase/migrations/0006_database_boundary.sql)
Davranış testleri: [`supabase/tests/rls.test.sql`](../supabase/tests/rls.test.sql) — `npm run test:db` (124 test)

> **Önemli:** RLS, BFF içinden yapılan `service_role` / secret key sorgularında
> UYGULANMAZ. Politikalar ve grant'lar, Supabase Data API'ye kullanıcı JWT'siyle
> doğrudan erişim girişimlerine karşı **ikinci savunma katmanıdır**. Birincil
> sınır sunucu tarafı actor authorization'dır (bölüm 14).

**İki ayrı katman:** tablo GRANT'ı "bu rol bu tabloya bu işlemi hiç yapabilir
mi?" sorusunu, RLS "hangi satırlara?" sorusunu yanıtlar. Hangi katmanın
reddettiği pgTAP'ta hata mesajıyla kanıtlanır: GRANT katmanı
`permission denied for table X`, RLS katmanı `row-level security policy`.

| Tablo | anon | authenticated (normal) | authenticated (admin) | service_role (BFF) |
| --- | --- | --- | --- | --- |
| `profiles` | — | Kendi satırını **okur** | Tümünü okur | Tam yetki |
| `portfolios`, `transactions`, `user_preferences` | — | Kendi satırlarını **okur** | Okur | Tam yetki (finansal yazma yalnızca kontrollü RPC ile) |
| `admin_audit_logs` | — | — (RLS boş liste) | Okur | SELECT + INSERT; UPDATE/DELETE kimseye yok |
| `app_sessions`, `login_rate_limits` | — | — (SELECT grant'ı bile yok) | — | Tam yetki |
| `gold_products`, `price_sources`, `current_prices` | — | Okur | Okur | Tam yetki |

İstemci rolleri hiçbir tabloya **INSERT/UPDATE/DELETE yapamaz**; profil bile
salt okunurdur (görünen ad değişikliği BFF üzerinden yapılır). Tüm tablolarda
`enable row level security` **ve** `force row level security` açıktır.

### 6.1 Yetki yükseltmenin engellenmesi

`prevent_profile_privilege_escalation` tetikleyicisi, yönetici olmayan bir kullanıcı kendi profilinde
`role`, `status`, `username` veya `must_change_password` alanlarını değiştirmeye çalışırsa
`42501` hatasıyla işlemi durdurur. Bu, uygulama katmanı atlansa bile geçerlidir.

`is_admin()` ve `current_role_name()` fonksiyonları `SECURITY DEFINER` ve sabit `search_path` ile
tanımlanır; böylece politikaların içinde `profiles` okunurken RLS özyinelemesi oluşmaz.

## 7. Sunucu anahtarı (`SUPABASE_SECRET_KEY` / `service_role`)

Tercih edilen değişken `SUPABASE_SECRET_KEY` (yeni `sb_secret_...` biçimi);
`SUPABASE_SERVICE_ROLE_KEY` yalnızca geriye uyumluluk için okunur ve ikisi de
yoksa üretim açık hata verir. Bu anahtar RLS'yi atlar; hiçbir `NEXT_PUBLIC_`
değişkenine, API yanıtına veya istemci paketine girmez
(`npm run verify:bundle` hem adları hem `sb_secret_` önekini tarar).

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
| Uzak (production) Supabase projesi yok; staging kurulumu kullanıcı girişine bağlı | Migration'lar, RPC'ler, tetikleyiciler, grant'lar ve RLS **yerel Supabase yığınında** (CLI + Docker, `supabase db reset` + 184 pgTAP + gerçek JWT sondası) doğrulandı | Staging araçları hazır (docs/STAGING.md): `staging:doctor` / `migrate` / `smoke` / `test:staging` |
| `SupabaseAuthBackend` uçtan uca yalnızca yerel yığına karşı sondalandı | Oturum rotation/renewal SQL yolu birim ve pgTAP düzeyinde doğrulandı; tarayıcı E2E testleri yerel arka uçla koşar | Uzak projede entegrasyon testi |
| CSP script-src satır içi koda izin verir | Next.js bootstrap script'i için gereklidir | Nonce tabanlı CSP (middleware ile) |
| `purge_expired_sessions()` / `login_rate_limit_cleanup()` otomatik çalışmıyor | Süresi geçen satırlar birikir (erişim yine reddedilir) | `supabase/setup/maintenance-cron.sql` idempotent pg_cron kurulumu sağlar; **çalıştığı iddia edilmez**, panelden kurulmalı ve `cron.job_run_details` ile doğrulanmalıdır |

## 12. Şirket bilgisayarları ve ortak cihaz kullanımı

Uygulama **hiçbir yerel program kurulmadan** kullanılabilir: EXE, MSI, BAT, tarayıcı eklentisi
veya yerel yardımcı (native helper) yoktur. Bütün özellikler normal bir HTTPS web uygulaması
olarak çalışır. PWA kurulumu tamamen isteğe bağlıdır; hiçbir özellik kurulu olmaya bağlı değildir
ve kurulu PWA ile normal tarayıcı kullanımı arasında görsel veya işlevsel fark yoktur.
`tests/deployment-surface.test.ts` bu kısıtları depo üzerinde denetler.

### 12.1 Tek ve kalıcı oturum modeli

Giriş ekranında cihaz türü **sorulmaz**; "Kişisel / Şirket cihazı" ayrımı,
15 dakikalık hareketsizlik çıkışı ve cihaz türüne bağlı davranışlar
(servis çalışanı temizleme, PWA kurulum çağrısının bastırılması)
**kaldırılmıştır**. Kullanıcı her cihazda **bir kez** giriş yapar; oturum siz
çıkış yapana kadar veya bir güvenlik olayına kadar açık kalır (bölüm 4 ve 16).

`app_sessions.device_mode` yalnızca eski veriyle uyumluluk için durur (0007 ile
null'lanır, kısıtları kaldırıldı) ve iş mantığında **kullanılmaz**.

### 12.2 Her cihazda geçerli kısıtlar

| Kısıt | Uygulama |
| --- | --- |
| "Beni hatırla" yok | Oturum zaten kalıcıdır; giriş ekranında böyle bir seçenek bulunmaz |
| Token/portföy tarayıcı deposuna yazılmaz | `localStorage` ve `sessionStorage` uygulama kodunda hiç kullanılmaz; IndexedDB yalnızca geliştirme demo modundadır |
| Hassas yanıtlar önbelleğe alınmaz | Servis çalışanı `/api/*` isteklerini ve kimliği doğrulanmış SAYFA yanıtlarını **hiç** önbelleğe yazmaz; internet yokken oturum varmış gibi finansal işlem kabul edilmez |
| Servis çalışanı | Yalnızca üretim derlemesinde kaydedilir; statik varlıklar ve çevrimdışı bilgi sayfası için |
| PWA kurulumu | İsteğe bağlı; uygulama hiçbir yerde `prompt()` çağırmaz ve kurulum bastırılmaz |
| Cihaz izni istenmez | Bildirim, push, konum veya kamera izni hiçbir kod yolunda talep edilmez |
| Cihaz metadata'sı | Yalnızca kaba etiket (tarayıcı · sistem), oluşturulma ve son görülme zamanı; ham IP / UA / parmak izi saklanmaz |

Tarayıcıdan giriş yapan kullanıcı PWA simgesinden açtığında platform aynı
çerez alanını paylaşıyorsa mevcut oturum kullanılır; ayrı saklama alanı
kullanan platformda kullanıcı o PWA bağlamında bir kez daha giriş yapar ve
sonra kalıcı kalır. Her cihaz aynı bulut portföyünü gösterir.

### 12.3 Oturum jetonu

- Jeton **yalnızca** `HttpOnly` çerezde taşınır; JavaScript ile okunamaz (`document.cookie`
  istemci kodunda hiç kullanılmaz ve `e2e/session.spec.ts` bunu tarayıcıda doğrular).
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

**Data API doğrudan mutation için kapalıdır (0006).** anon ve authenticated
rolleri kişisel/finansal tablolara INSERT/UPDATE/DELETE yapamaz; kritik
SECURITY DEFINER RPC'ler yalnızca `service_role` ile çağrılır. Finansal
mutation **yalnızca** BFF + kontrollü RPC (`*_transaction_checked`) yolundan
geçer. Ayrıntı: bölüm 22.

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
| `requireAuthenticatedUser` | **Geçer** | `/api/auth/session`, `/api/auth/logout`, `/api/auth/logout-all`, `/api/auth/change-password` |
| `requireUsableUser` | **Geçemez** | Portföy, işlemler, ayarlar |
| `requireCurrentAdmin` | **Geçemez** | Tüm yönetim uçları |

Reddedilen istek `403` ve `code: "PASSWORD_CHANGE_REQUIRED"` döner. Arayüz
yönlendirmesi tek önlem DEĞİLDİR; sunucu bağımsız olarak reddeder.
Parola değiştikten sonra **bu cihazdaki oturum korunur**; diğer cihazlardaki
oturumlar güvenlik için kapatılır. `/api/auth/logout-all` da bu guard'ı kullanır.

## 16. Sunucu tarafı oturum geçerliliği

| Parametre | Değer | Sabit |
| --- | --- | --- |
| Kaydırmalı ömür | 180 gün | `SESSION_ROLLING_LIFETIME_MS` |
| Süre uzatma sıklığı | en fazla 24 saatte bir | `SESSION_RENEWAL_INTERVAL_MS` |
| `last_seen_at` yazma sıklığı | en fazla 15 dakikada bir | `SESSION_TOUCH_INTERVAL_MS` |
| Kimlik yenileme aralığı | 7 gün | `SESSION_ROTATION_INTERVAL_MS` |
| Eski kimlik tolerans süresi | 60 sn | `SESSION_ROTATION_GRACE_MS` |
| Hareketsizlik zaman aşımı (kalıcı oturum) | **yok** | — |
| Tarayıcı oturumu (işaretsiz) | 8 saat mutlak, 30 dk hareketsizlik | `BROWSER_SESSION_ABSOLUTE_MS`, `BROWSER_SESSION_IDLE_MS` |
| Admin oturumu | 8 saat mutlak, 15 dk hareketsizlik | `ADMIN_SESSION_ABSOLUTE_MS`, `ADMIN_SESSION_IDLE_MS` |

`app_sessions` tablosunda `expires_at` (kaydırmalı bitiş), `renewed_at`,
`rotated_at`, `previous_token_hash` / `previous_token_valid_until`,
`device_label`, `last_seen_at` ve `revoked_at` alanları tutulur (`0007`).
`resolveSession()` her istekte iptal, bitiş ve hesap durumunu kontrol eder;
süresi geçen oturumun kaydı silinir. `idle_expires_at` ve `device_mode`
deprecated'dır ve yetkilendirme kararında **kullanılmaz**.

- Yenileme her API çağrısında DB yazmaz (`tests/persistent-session.test.ts` →
  "her API çağrısında veritabanına YAZILMAZ").
- İstemcide hareketsizlik sayacı veya otomatik çıkış **yoktur**; güvenlik
  sınırı sunucudadır (iptal listesi + kaydırmalı bitiş + rotation).
- `purge_expired_sessions()` iptal edilmiş ve süresi dolmuş satırları temizler
  (`supabase/setup/maintenance-cron.sql`).

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
- `login_rate_limit_cleanup()` eski sayaçları temizler (pg_cron kurulumu:
  `supabase/setup/maintenance-cron.sql`).
- Üç sayaç (IP, kullanıcı adı, kombinasyon) aynı Postgres tablosunda farklı
  eşiklerle tutulur; her sayacın anahtarı ayrı HMAC'lenir. Bellek uygulaması
  da her eşik seti için ayrı kayan pencere kullanır.

## 19. Veritabanı bütünlüğü

`0005_security_hardening.sql` ile eklenenler:

| Kural | Nasıl |
| --- | --- |
| Kullanıcı başına tek portföy | `portfolios(user_id)` UNIQUE |
| İşlemin portföyü sahibiyle uyumlu | `transactions(portfolio_id, user_id)` composite foreign key |
| Birim ürün kataloğuyla uyumlu | `enforce_transaction_unit()` tetikleyicisi |
| Adet ürününde tam sayı miktar | Aynı tetikleyici |
| Aşırı satış engeli (eşzamanlı dâhil) | `lock_user_portfolio()` + `assert_no_oversell()` içeren atomik RPC'ler |
| Portföy yalnızca provisioning ile oluşur | `profiles` AFTER INSERT tetikleyicisi (`0006`); `lock_user_portfolio()` artık portföy **oluşturmaz**, yoksa `ALTIN_PORTFOLIO_NOT_PROVISIONED` verir |

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

## 22. Veritabanı yetki sınırı (`0006_database_boundary.sql`)

Tarayıcı Supabase'e doğrudan yazmaz; bütün mutation'lar
`Next.js BFF → doğrulanmış app_session → markalanmış actor/scope → server-only
secret key client → PostgreSQL` yolundan geçer. `0006`, bu yolun **atlanmasını**
PostgreSQL yetkileriyle engeller.

### 22.1 Fonksiyon yetki matrisi

| Fonksiyon | anon | authenticated | service_role |
| --- | --- | --- | --- |
| `create_transaction_checked`, `update_transaction_checked`, `delete_transaction_checked` | — | — | EXECUTE |
| `login_rate_limit_check`, `_record_failure`, `_reset`, `_cleanup` | — | — | EXECUTE |
| `purge_expired_sessions`, `provision_missing_defaults` | — | — | EXECUTE |
| `assert_no_oversell`, `lock_user_portfolio`, `provision_user_defaults` | — | — | — |
| Tetikleyici fonksiyonları (`reject_audit_mutation`, `enforce_transaction_unit`, `touch_updated_at`, `prevent_profile_privilege_escalation`, `provision_user_defaults_trigger`) | — | — | — |
| `current_role_name`, `is_admin` (RLS yardımcıları) | — | EXECUTE | — |

Dahili yardımcılar hiçbir role açık değildir; SECURITY DEFINER fonksiyonlar
onları sahip yetkisiyle çağırır, tetikleyiciler EXECUTE yetkisine bakmaz.
Migration, yetkileri **tam imzayla** ve her rolden ayrı ayrı alır
(`revoke ... from public` tek başına yeterli değildir).

**Varsayılan yetkiler:** PostgreSQL yeni fonksiyonlara örtük olarak PUBLIC
EXECUTE verir ve şema düzeyi varsayılan ACL'yi global varsayılanla
birleştirir. `0006` bu yüzden hem global hem `public` şeması için `postgres`
rolünün varsayılan fonksiyon yetkilerinden PUBLIC/anon/authenticated'ı kaldırır
(yalnızca migration rolü `postgres` üyesiyse; değilse NOTICE ile bildirir).
pgTAP testi bunu gerçek bir fonksiyon oluşturarak doğrular.

### 22.2 Tablo yetkileri

Bölüm 6'daki matris. anon hiçbir şey okuyamaz; authenticated yalnızca SELECT
(satır kapsamı RLS ile); `app_sessions` ve `login_rate_limits` istemci
rollerine tamamen kapalı; `admin_audit_logs` için UPDATE/DELETE grant'ı
**hiçbir role** yok (tetikleyici ayrıca engeller).

### 22.3 Kaldırılan yazma politikaları

`portfolios_insert/update/delete_own`, `transactions_insert/update/delete_own`,
`user_preferences_all_own` ve `profiles_update_self` kaldırıldı; yerine yalnızca
`user_preferences_select_own` eklendi. `public` şemasında SELECT dışında RLS
politikası **yoktur** (pgTAP bunu `pg_policies` üzerinden doğrular).

### 22.4 Varsayılan portföy provisioning

- Profil eklenince `profiles_provision_defaults` (AFTER INSERT) tetikleyicisi
  portföyü ve tercih kaydını **aynı transaction** içinde hazırlar; yarım hesap
  kalmaz. `provision_user_defaults()` idempotenttir (`on conflict do nothing`).
- `GET /api/portfolio` **hiçbir koşulda veri oluşturmaz**; portföy yoksa
  `500 portfolio_not_provisioned` döner (`tests/provisioning.test.ts` yazma
  sayacıyla kanıtlar). `LocalAuthBackend` aynı davranışı yansıtır.
- Onarım: `provision_missing_defaults()` (yalnızca `service_role`) veya
  `npm run admin:repair`; idempotenttir, ikinci çağrı 0 döner.

### 22.5 Doğrulama durumu (dürüst)

- `npm run test:db`: yerel Supabase yığınında (CLI 2.116, Docker) `supabase db
  reset` ile 0001→0012 temiz uygulandı; **184 pgTAP testinin tamamı geçti**.
  0006, 0011 ve 0012 iki kez uygulanarak idempotentlik doğrulandı.
- `npm run test:data-api`: gerçek anon anahtarı ve yerel JWT secret'ıyla
  imzalanmış authenticated JWT ile PostgREST üzerinden 46 beklenti karşılandı
  (okuma RLS kapsamlı, yazma/RPC 401/403 `42501`, BFF yolu çalışır).
- Uzak production Supabase projesi **oluşturulmadı**; bu sonuçlar yerel yığına aittir.

## 23. Üretim sertleştirme: origin, vekil, anahtar

- **`APP_ORIGIN` üretimde zorunludur.** `Host` / `X-Forwarded-Host`
  başlıklarından origin türetilmez; eksikse durum değiştiren istekler
  `500 misconfigured` ile reddedilir (fail closed). E2E testleri değişkeni
  açıkça ayarlar; başka bir "override" yolu yoktur (`tests/production-origin.test.ts`).
- **`TRUSTED_PROXY_PROVIDER`** = `vercel` \| `local` \| `none`.
  `X-Forwarded-For` / `X-Real-IP` yalnızca güvenilir sağlayıcıda okunur;
  bilinmeyen değer veya boş (üretimde) → `none`: başlıklar yok sayılır, saldırgan
  kendine IP uyduramaz (`tests/client-ip.test.ts`). Ham IP hiçbir loga veya
  tabloya yazılmaz; yalnızca HMAC'li sayaç anahtarına girer.
- **`SUPABASE_SECRET_KEY`** tercih edilir, `SUPABASE_SERVICE_ROLE_KEY`
  geriye uyumluluk; üretimde ikisi de yoksa açık hata. İstemci paketi
  taraması her iki adı ve `sb_secret_` önekini arar.
- **Kaynak paketi** saf Node ile yazılır: giriş adları her platformda `/`
  ayraçlıdır, arşiv yeniden açılıp her girişin CRC'si kaynakla karşılaştırılır,
  giriş sayısı manifestle eşleştirilir; `.git`, `node_modules`, `.next`,
  `.data`, `.env*` (örnek hariç), test çıktıları dışlanır.

## 24. Muhasebe defteri sınırı (`0009` / `0010`)

- **Finansal mutation yalnızca BFF + kontrollü RPC — veritabanı bunu ZORUNLU kılar (0011):**
  `service_role` `public.transactions` ve `public.price_snapshots` tablolarına doğrudan
  INSERT/UPDATE/DELETE yapamaz (yalnızca SELECT); `portfolio_positions` zaten kapalıdır.
  `ledger_append`, `ledger_void`, `ledger_replace`, `ledger_void_all` SECURITY DEFINER'dır
  (sabit `search_path`, sahip `postgres`) ve yalnızca `service_role` çağırabilir;
  `ledger_list` / `positions_list` / `ledger_verify` de öyle. Yardımcı fonksiyonlar hiçbir role
  açık değildir. authenticated JWT ile hiçbiri çağrılamaz (pgTAP + `npm run test:data-api`);
  statik test uygulama kodunda bu tablolara `.from()` erişimi bulunmadığını doğrular.
- **Kullanıcı kimliği actor'dan gelir:** hiçbir uç gövdeden `userId` almaz; başka kullanıcının
  işlem kimliği tahmin edilse bile `404` döner (kapsam dışı kayıt "yok" sayılır).
- **Admin salt okur:** `AdminService` içinde BUY/SELL/OPENING_BALANCE/VOID/REPLACE metodu
  yoktur (`tests/admin-service.test.ts` prototipi denetler); görüntüleme denetim kaydı üretir.
- **Defter append-only:** finansal alanlar tetikleyiciyle değiştirilemez; hard delete yalnızca
  hesap cascade'inde; iptal/düzeltme sebep ve tarihle kayıt altındadır (audit trail).
- **Projeksiyon elle değişmez:** `portfolio_positions` tablosuna `service_role` dâhil hiçbir rol
  INSERT/UPDATE/DELETE yapamaz; yalnızca RPC (sahip yetkisiyle) yeniden oluşturur.
- **Fiyat anlık görüntüsü:** `price_snapshots` yalnızca `ledger_append` içinde, sunucu fiyat
  sağlayıcısından yazılır; istemci fiyat gönderemez; UPDATE/DELETE reddedilir. Makas
  (`replacement >= liquidation`), para birimi, ürün eşleşmesi, sağlayıcı/piyasa ve zaman
  (geçersiz / gelecek / bayat) hem RPC'de hem tablo kısıtında denetlenir.
- **İşlem zamanı:** takvimde olmayan tarih ve gelecek zaman RPC'de P0004 ile reddedilir;
  `occurred_at` / `occurred_time` guard tetikleyicisiyle değiştirilemez.
- **Idempotency:** `(user_id, client_request_id)` benzersiz; aynı içerik replay (200), farklı
  içerik `409 idempotency_conflict`. Anahtar kullanıcı kapsamlıdır.
- **Girdi sertleştirme:** miktar/tutar dizeleri sıkı desenle ayrıştırılır; NaN, Infinity,
  bilimsel gösterim, aşırı büyük değer ve fazla ondalık reddedilir; birim istemciden alınmaz.
- **Doğrulama durumu:** yerel Supabase yığınında 184 pgTAP testi, gerçek JWT sondası
  (46 beklenti; hesap silme cascade'i gerçek auth ucuyla kanıtlanır), `npm run accounting:smoke`
  (gerçek RPC yolu) ve `npm run accounting:verify` geçti. Uzak proje için bkz. docs/STAGING.md.

## 25. Senkronizasyon ucu ve staging (Sprint 2)

- `GET /api/portfolio/version`: yalnızca oturumdaki kullanıcının sürümü; hedef `userId`
  alınmaz; salt okunur (CSRF gerektirmez); `Cache-Control: private, no-store`, `Vary: Cookie`;
  ETag eşleşince gövdesiz 304. Supabase access token tarayıcıya çıkmaz; Realtime kullanılmaz.
- Hesap silme cascade'i gerçek `auth.admin.deleteUser` ucuyla kanıtlanır: silme sonrası
  `profiles`, `portfolios`, `transactions`, `price_snapshots`, `portfolio_positions`,
  `app_sessions`, `user_preferences` satırları 0 (pgTAP §14 + Data API sondası). Doğrudan
  hard delete hâlâ reddedilir; sonda temizliği başarısız silmeyi sessizce yok saymaz.
- Staging: gerçek secretlar `.env.staging.local`'da (gitignore, paket dışı); araçlar değer
  yazdırmaz; `STAGING_ENVIRONMENT=staging`, sabit https `APP_ORIGIN`, demo modu kapalı,
  production ref koruması ve NEXT_PUBLIC_ secret taraması **fail closed** uygulanır. Test
  hesaplarının parolaları yalnızca `.staging/accounts.local.json` (0600) dosyasındadır.

## 26. Fiyat sağlayıcı sınırı (Sprint 3)

**Anahtarlar yalnızca sunucudadır.** Sağlayıcı adresi, API anahtarı ve lisans referansı
`src/prices/providers/*` içinde `process.env` üzerinden okunur. Bu modüller istemci paketine
girmez (`npm run verify:bundle`), veritabanına yazılmaz ve API yanıtına konmaz. `price_providers`
tablosu yalnızca lisans **durumunu** ve **referans metnini** tutar.

**Lisans kapısı fail closed'dır.** Sağlayıcı üç durumdan birindedir:

| Durum | Anlamı | Davranış |
| --- | --- | --- |
| `NOT_CONFIGURED` | Gerekli ortam değişkenlerinden biri eksik | Veri çekmez, etkinleştirilemez |
| `LICENSE_REQUIRED` | Ayar var ama yeniden gösterim izni açıkça `true` değil | Veri çekmez, etkinleştirilemez |
| `LICENSED` | Ayar tam + izin `true` | Yönetici etkinleştirebilir |

`enabled = true` yalnızca `LICENSED` iken mümkündür; veritabanı kısıtı bunu ayrıca zorlar.
Lisans düşerse katalog eşitlemesi kaynağı otomatik kapatır. Lisanssız kaynağı etkinleştirme
girişimi `409` döner ve denetim kaydına yazılır.

**Hata mesajları güvenlidir.** Sağlayıcı hataları `TIMEOUT`, `NETWORK`, `HTTP_401`, `HTTP_403`,
`HTTP_5XX`, `BAD_PAYLOAD` gibi sabit kodlara indirgenir. Ham yanıt, URL ve anahtar hiçbir loga,
API yanıtına veya yönetim ekranına yazılmaz; tarihçede yalnızca yanıt özeti (hash) tutulur.

**Zamanlanmış alım ucu.** `POST /api/cron/price-ingestion` oturum kullanmaz; `PRICE_CRON_SECRET`
ile `Authorization: Bearer` veya `X-Cron-Secret` başlığından doğrulanır. Secret tanımsızsa uç
**kapalıdır** (403). Karşılaştırma sabit zamanlıdır. Test sağlayıcısı üretim koşumunda atlanır.

**İstemci sağlayıcıya bağlanmaz.** Bütün alım sunucu tarafındadır; tarayıcı yalnızca kendi
API'mizi okur. Böylece anahtar sızmaz ve sağlayıcı istek limiti kullanıcı sayısıyla çarpılmaz.

**Sessiz fallback yasağı.** Aktif kaynak başarısız olduğunda başka sağlayıcıya, başka piyasaya
veya başka şehrin fiyatına geçilmez. Bu bir güvenlik değil **veri doğruluğu** sınırıdır ve
`tests/price-sources.test.ts` ile E2E'de doğrulanır.

## 27. Yönetici ikinci faktörü (TOTP)

- **Zorunludur.** `requireCurrentAdmin()` artık oturumun `mfa_verified_at` alanını kontrol eder.
  Kurulmamış veya doğrulanmamış oturum yönetim uçlarında `403` alır; arayüz `/guvenlik` sayfasına
  yönlendirir. Menü gizlemek tek başına önlem sayılmaz.
- **Algoritma:** RFC 6238 TOTP, 30 saniyelik pencere, ±1 tolerans, sabit zamanlı karşılaştırma.
- **Secret dinlenmede şifrelidir:** AES-256-GCM, anahtar `AUTH_MFA_ENCRYPTION_KEY` ortam
  değişkeninden gelir. Veritabanında açık secret sütunu yoktur.
- **Kurtarma kodları** yalnızca SHA-256 özetiyle saklanır, tek kullanımlıktır ve bir kez gösterilir.
- **Kaba kuvvet:** 5 başarısız denemeden sonra kilit; denemeler denetim kaydına yazılır (kod yazılmaz).
- **Sıfırlama** yalnızca başka bir yönetici tarafından, kullanıcı adı birebir yazılarak yapılır.
  Sıfırlama hedefin bütün oturumlarını kapatır ve ayrı denetim kaydı üretir.
- Parola değişimi ikinci faktörü sessizce kaldırmaz.

## 28. Kullanıcı veri hakları (Sprint 3)

- **Dışa aktarma:** `GET /api/portfolio/export` yalnızca oturum sahibinin kendi verisini üretir
  (işlem defteri veya pozisyonlar, noktalı virgülle ayrılmış CSV, ondalık dize). Hedef `userId`
  parametresi kabul edilmez. Kullanıcının yazdığı serbest metin (not, iptal sebebi) `=`, `+`,
  `-`, `@` veya sekme ile başlıyorsa tek tırnakla düz metne zorlanır; hücre Excel/LibreOffice
  tarafından formül olarak çalıştırılamaz.
- **Silme talebi:** `POST /api/account/deletion-request` talebi denetim kaydına yazar; silmeyi
  **yapmaz**. Gerçek silme yalnızca yöneticinin kullanıcı adı onayıyla yaptığı cascade işlemidir.
- **Gizlilik sayfası** hangi verinin neden tutulduğunu, fiyatların bağlayıcı teklif olmadığını ve
  yatırım tavsiyesi verilmediğini açıkça belirtir.

## 29. Makine (cron) ucu — Sprint 3.1

Zamanlanmış alım ucu artık tarayıcı sarmalayıcısını kullanmaz. Gerekçe bir güvenlik
gevşetmesi değil, **doğru kimlik modelidir**: bir zamanlayıcının çerezi yoktur, bu yüzden
CSRF kontrolü onu doğru secret'la bile reddederdi.

`machineRoute` (`src/server/security/machine-route.ts`):

- Kimlik YALNIZCA paylaşılan secret'tır; `Origin`, `Referer` veya çereze güvenilmez.
- Karşılaştırma sabit sürelidir; secret tanımsızsa uç kapalıdır (403).
- Oturum çözülmez, çerez yazılmaz, oturum ömrü uzatılmaz. Makine çağrısı hiçbir kullanıcı
  oturumunu etkilemez.
- Koşum anahtarı istemciden gelmez; sunucu dakikaya yuvarlayarak üretir. Aynı dakikadaki
  tekrar çağrı ikinci fiyat geçmişi satırı oluşturmaz.
- Yanıt secret, upstream adres veya ham payload içermez.

**Normal mutation uçlarının CSRF koruması değişmemiştir** ve bu, `tests/price-runtime.test.ts`
§1 ile ayrıca denetlenir.

## 30. Yönetici TOTP replay koruması

Bir TOTP kodu 30 saniyelik pencere içinde YALNIZCA BİR KEZ kabul edilir.

- `verifyTotp` artık eşleşen zaman adımını (counter) döndürür.
- `admin_mfa_credentials.last_used_counter` bu adımı saklar.
- Talep ATOMİKTİR: tek koşullu UPDATE (`last_used_counter is null or last_used_counter < $2`).
  İki eşzamanlı oturum aynı kodu gönderirse yalnızca birinin koşulu tutar; oku-sonra-yaz
  yapılsaydı ikisi de geçebilirdi.
- Kurulum onayı da sayacı tüketir; aynı kod ikinci bir oturumu doğrulayamaz.
- ±1 pencere ve kurtarma kodu davranışı korunur. Sıfırlama kaydı sildiği için sayaç temizlenir.

## 31. Test verisi kapısı ayrıldı

Test sağlayıcısının kapısı artık yerel auth kapısından bağımsızdır (`src/prices/dev-gate.ts`).
Üç kademe vardır ve en katı olan kazanır:

1. **Gerçek üretim dağıtımı** (`VERCEL_ENV=production` veya `APP_DEPLOYMENT_ENV=production`):
   test verisi hiçbir override ile açılamaz.
2. **Üretim derlemesi** (Playwright): yalnızca `PRICE_ALLOW_MOCK_PROVIDER` belirteciyle.
3. **Geliştirme:** açık.

Ayrıca katalog eşitlemesi üretimde açık kalmış bir test sağlayıcısını zorla kapatır; staging'de
açılmış test verisi, aynı veritabanı üretime taşındığında sessizce kullanıcıya gitmez.

## 32. Deneysel ekran toplayıcısı

`SarrafTvKayseriScreenCollector` üretim sağlayıcı kaydına **eklenmemiştir** ve varsayılan
olarak kapalıdır. Yalnızca `PRICE_EXPERIMENTAL_SARRAF_SCREEN=true` iken ve üretim dağıtımı
DIŞINDA çalışır. Veri türü `LIVE_SCREEN_EXPERIMENTAL`'dir; `LICENSED`, `OFFICIAL_API` veya
`SARRAF_PRO_API` olarak etiketlenmez. CAPTCHA/etkileşim istenirse `BLOCKED` döner ve aşma
denenmez; ekran imzası değişirse fail closed olur ve hiç fiyat üretilmez.

## 33. Worker makine ucu (Sprint 3.2)

`/api/internal/price-worker/sarraf-screen` ve `.../lease` uçları tarayıcı için
değildir. Oturum çerezi kabul etmez, CSRF çerezi üretmez (`MACHINE_PATHS`),
kimlik yalnızca imzadan gelir.

### İmza formatı

```
HMAC-SHA256( timestamp \n nonce \n bodySha256 \n workerId )
```

| Kontrol | Reddetme kodu |
| --- | --- |
| Secret tanımsız | `MISSING_SECRET` (uç kapalıdır) |
| İmza uyuşmuyor | `SIGNATURE_MISMATCH` |
| Gövde hash'i uyuşmuyor | `BODY_HASH_MISMATCH` |
| Zaman damgası ±60 sn dışında | `TIMESTAMP_OUT_OF_RANGE` |
| Nonce daha önce kullanılmış | `NONCE_REPLAY` |
| Kirayı tutmuyor | `LEASE_NOT_HELD` |
| Eski kira jetonu | `LEASE_TOKEN_STALE` |

İmza karşılaştırması sabit zamanlıdır. Gövde hash'i imzaya dâhildir, yani
imzalı bir isteğin gövdesi değiştirilemez.

İmza üretimi iki ayrı dosyadadır (worker `server-only` içe aktaramaz):
`services/sarraf-screen-worker/src/signing.ts` ve
`src/server/security/worker-signature.ts`. `tests/private-pilot.test.ts` ikisinin
birebir uyumlu kaldığını doğrular; biri değişip diğeri unutulursa test kırılır.

### Worker'ın yetki sınırı

Worker'a **Supabase anahtarı verilmez**. Ortam değişkenleri arasında
`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` veya `service_role` bulunmaz.
Bu bir konvansiyon değil, testle denetlenen bir kuraldır: worker kaynak
dosyaları (yorumlar ayıklanarak) bu adlara karşı taranır.

Worker'ın tek yeteneği imzalı fiyat gözlemi göndermektir. Gönderdiği fiyat
diğer bütün kaynaklarla **aynı** kalite kapısından geçer; ayrıcalığı yoktur.

### Tek yazar garantisi

Kira (lease) sağlayıcı başına tek yazar sağlar. Kira jetonu kiranın alınma
zamanından türetilir; eski jetonla gelen yazma reddedilir. Böylece ağ gecikmesi
nedeniyle geciken eski bir gözlem, yeni gözlemin üzerine yazamaz.

## 34. Deneysel kaynak erişimi çift katmanlıdır

`EXPERIMENTAL_PRIVATE` kaynak genel kullanıcı listesine **çıkamaz**; kısıt
veritabanındadır (`price_providers_experimental_not_public`).

Erişim iki yerde birden doğrulanır:

1. Uygulama katmanı: `PriceSourceService` izin listesini sorgular.
2. Veritabanı: `price_preference_set` RPC'si `experimental_access_allowed`
   çağırır ve izinsiz seçimi `P0006` ile reddeder.

Arayüzün kaynağı göstermesi tek başına yetki sayılmaz. İzin geri alındığında
veya süresi dolduğunda kullanıcı başka bir kaynağa **sessizce düşürülmez** —
fiyat gösterilmez ve nedeni yazılır.

### Ne saklanmaz

Fizibilite ve pilot çalışmaları sırasında şunlar **hiçbir yerde saklanmaz**:
sayfanın JWT'si, `screenPass` değeri, çerezler, `Authorization` başlıkları,
reCAPTCHA token'ları, sorgu içindeki anahtarlar. Ağ özetleri deny-by-default
şema özeti olarak çıkarılır; `token|key|password|id|url` kalıbına uyan alan
adları redakte edilir (`tools/experimental/sarraf-tv-kayseri/network-contract.ts`).

## 35. Ortam değişkeni okuma: sessiz sıfıra düşme yasağı

`Number(process.env.X ?? "0.15")` kalıbı sessiz bir arıza üretir. `??` yalnızca
`undefined` ve `null` için devreye girer; değişken **tanımlı ama boş** ise
(`PRICE_MAX_TRY=`) varsayılan atlanır ve `Number("")` **0** döner.

Bu, projedeki "sessiz fallback yasağı" ilkesinin ihlalidir ve gerçek bir
güvenlik etkisi vardır:

| Değişken boş bırakılırsa | Eski davranış | Sonuç |
| --- | --- | --- |
| `PRICE_MAX_TRY=` | Üst sınır 0 | Bütün fiyatlar reddedilir |
| `PRICE_MIN_TRY=` | Alt sınır 0 | Sıfıra yakın saçma fiyatlar kabul edilir |
| `PRICE_MAX_CHANGE_RATIO=` | Eşik 0 | Devre kesici anlamını yitirir |
| `WORKER_ID=` | Kimlik boş metin | Kira boş kimliğe yazılır; iki worker "sahip" görünebilir |

Hiçbiri log üretmez ve dağıtım başarılı görünür.

**Kural:** sayısal ve metinsel ayarlar `src/lib/env.ts` üzerinden okunur
(`numberFromEnv`, `stringFromEnv`, `flagFromEnv`). Boş/boşluk değer
"ayarlanmamış" sayılır; geçersiz veya sınır dışı değer varsayılana düşer.
Worker `@/` alias'ını kullanamadığı için aynı kuralın kopyası
`services/sarraf-screen-worker/src/policy.ts` içindedir ve iki kopyanın aynı
davrandığı testle doğrulanır.

`tests/env-parsing.test.ts` ham `Number(process.env...)` kalıbının `src/` ve
`services/` altına geri gelmesini engeller.

## 36. Özel pilot ortam kapısı

Ürün kararı: deneysel Sarraf TV ekran kaynağı **herkese açık üretimde asla**
çalışmaz, ama ayrı bir "özel pilot" ortamında açıkça etkinleştirilebilir.

Kapı üç anahtarın hepsini ister (`src/prices/dev-gate.ts`):

| Değişken | Gerekli değer |
| --- | --- |
| `APP_DEPLOYMENT_ENV` | `private-pilot` |
| `PRICE_EXPERIMENTAL_SARRAF_SCREEN` | `true` |
| `PRICE_EXPERIMENTAL_PRIVATE_PILOT` | `true` |

Fail closed durumları:

| `APP_DEPLOYMENT_ENV` | Sonuç |
| --- | --- |
| tanımsız | Kapalı |
| tanınmayan değer (örn. `private_pilot`) | Kapalı |
| `production` | Kapalı |
| `public-production` | Kapalı |
| `private-pilot` + iki bayrak | **Açık** |

`VERCEL_ENV=production` tek başına engellemez. Bu bilinçlidir: barındırma
hedefi ile ürün ortamı farklı kavramlardır ve özel pilot Vercel'in production
hedefinde barınabilir. Ayrım açıkça beyan edilen `APP_DEPLOYMENT_ENV`
değerine dayanır.

**Test verisi kapısı ayrıdır ve değişmedi.** `devOnlyProviderBlocked()` üretim
dağıtımında (`VERCEL_ENV=production` veya `APP_DEPLOYMENT_ENV` production
ailesi) koşulsuz kapalıdır. Deneysel kaynağı açmak mock'u açmaz; özel pilotta
bile mock kapalı kalır ve bu testle denetlenir.

Bu kapı **erişim izni değildir**. Kaynak açık olsa bile:

- veritabanı kısıtı kaynağın genel kullanıcı listesine çıkmasını engeller
  (`price_providers_experimental_not_public`),
- hangi portföyün kullanabileceği yöneticinin izin listesinden gelir
  (`experimental_access_allowed`, hem uygulama hem SQL katmanında),
- hangi ürünün değerleneceği eşleme güveniyle belirlenir
  (`VALUATION_READY_CONFIDENCE`),
- gözlem 120 sn'den eskiyse fiyat reddedilir.
