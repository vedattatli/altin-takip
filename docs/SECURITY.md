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

> **Üretim notu:** sayaç süreç belleğindedir. Çok örnekli (birden fazla sunucu) dağıtımda
> paylaşımlı bir depoya (Redis veya Postgres) taşınmalıdır. Bkz. [ROADMAP.md](ROADMAP.md).

## 6. Satır düzeyi güvenlik (RLS)

Politikalar: [`supabase/migrations/0002_rls.sql`](../supabase/migrations/0002_rls.sql)

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
| Hız sınırı süreç belleğinde | Çok örnekli dağıtımda sayaç bölünür | Redis/Postgres'e taşı |
| CSRF için ayrı token yok | `sameSite=lax` çerez + JSON gövde gereksinimi ile azaltılmıştır | Sprint 1'de çift gönderim çerezi |
| Sunucu verilere `service_role` ile eriştiği için RLS çalışma zamanında ikinci savunma hattıdır | Uygulama hatası veri sızdırabilir | Erişimler her zaman oturumdan gelen `user_id` ile filtrelenir; testlerle doğrulanır |
| Supabase ortamı olmadan `SupabaseAuthBackend` çalıştırılamadı | Bu yol yerel olarak doğrulanmadı | Supabase projesi açıldığında entegrasyon testi |

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

## 13. Secret yönetimi

- Depoya **yalnızca** `.env.example` girer ve içinde gerçek değer bulunmaz.
- `.gitignore` tüm `.env*` dosyalarını dışlar (`.env.example` hariç) ve `.data/` klasörünü kapsar.
- `npm run admin:create` parolayı ekrana yazdırmaz, kabuk geçmişine düşürmez ve loglamaz.
