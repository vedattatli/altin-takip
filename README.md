# Altın Takip

Türkiye'deki altın portföylerini telefonda, tablette ve bilgisayarda tek yerden takip etmek için
geliştirilen responsive web uygulaması ve PWA.

- Kurulum gerektirmez: tarayıcıda çalışır, ana ekrana uygulama olarak eklenebilir.
- EXE, MSI, BAT, tarayıcı eklentisi veya yerel yardımcı yoktur; şirket bilgisayarlarında
  hiçbir program kurmadan kullanılır. PWA kurulumu tamamen isteğe bağlıdır.
- Excel, Python veya yönetici izni gerekmez.
- Hesaplar **yalnızca yönetici tarafından** oluşturulur; herkese açık kayıt yoktur.
- Giriş **kullanıcı adı + parola** iledir. E-posta, telefon, OTP veya sihirli bağlantı kullanılmaz.
- Fiyatlar bu sürümde **test verisidir**; gerçek piyasa verisi değildir.

Ürün adı tek bir yerden yönetilir: [`src/config/app.config.ts`](src/config/app.config.ts).

---

## Hızlı başlangıç (yerel geliştirme)

Supabase hesabı olmadan da uygulamayı uçtan uca çalıştırabilirsiniz. Bu durumda **yalnızca
geliştirme ortamında** çalışan yerel bir kimlik doğrulama arka ucu devreye girer.

```bash
npm install
```

```bash
cp .env.example .env.local
```

```bash
npm run admin:create -- --local
```

Komut kullanıcı adı ve görünen adı sorar, parolayı görünmeden alır ve ekrana yazdırmaz.

```bash
npm run dev
```

`http://localhost:3000` adresine gidin ve oluşturduğunuz yönetici hesabıyla giriş yapın.
Yönetim ekranından son kullanıcıları oluşturabilirsiniz.

> Yerel arka uç verileri `.data/auth-local.json` dosyasında tutulur. Bu dosya `.gitignore` ile
> dışlanmıştır ve üretim derlemesinde kullanılamaz. Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md).

---

## Supabase ile kurulum

1. Supabase'de yeni bir proje oluşturun.
2. `.env.local` dosyasını doldurun:

   | Değişken | Açıklama |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Proje URL'si |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anahtar. Tarayıcı bununla doğrudan yazamaz (Data API yazma yüzeyi kapalı) |
   | `SUPABASE_SECRET_KEY` | **Yalnızca sunucu.** Yeni `sb_secret_...` biçimi. `NEXT_PUBLIC_` öneki asla verilmez; RLS'yi atlar |
   | `SUPABASE_SERVICE_ROLE_KEY` | Geriye uyumluluk (eski `service_role` JWT). `SUPABASE_SECRET_KEY` doluysa yok sayılır |
   | `AUTH_INTERNAL_EMAIL_DOMAIN` | Kullanıcı adından türetilen dahili kimliğin alan adı |
   | `AUTH_CSRF_SECRET` | CSRF jetonlarını imzalar. **Üretimde zorunlu** |
   | `RATE_LIMIT_PEPPER` | Hız sınırlayıcı anahtarını gizler. **Üretimde zorunlu** |
   | `APP_ORIGIN` | Beklenen origin. **Üretimde zorunlu**; Host başlığından türetilmez (fail closed) |
   | `TRUSTED_PROXY_PROVIDER` | `vercel` \| `local` \| `none`. `X-Forwarded-For` yalnızca güvenilir vekilde okunur; üretimde boşsa `none` |

3. `supabase/migrations/` altındaki SQL dosyalarını **sırayla** çalıştırın:

   ```
   0001_init.sql                  -> tablolar, kısıtlar, indeksler
   0002_rls.sql                   -> satır düzeyi güvenlik politikaları
   0003_seed_reference_data.sql   -> altın ürün kataloğu ve fiyat kaynağı
   0004_device_mode.sql           -> (eski) oturum cihaz türü; 0007 ile kullanım dışı
   0005_security_hardening.sql    -> bütünlük kısıtları, atomik işlem yazımı,
                                     dağıtık hız sınırlayıcı, denetim kaydı tetikleyicileri
   0006_database_boundary.sql     -> veritabanı yetki sınırı: fonksiyon/tablo grant'ları,
                                     Data API doğrudan yazma yüzeyinin kapatılması,
                                     varsayılan portföy provisioning tetikleyicisi
   0007_persistent_sessions.sql   -> kalıcı, kaydırmalı ve kimliği yenilenen oturum modeli
   ```

   Bakım görevleri (pg_cron) için ayrıca bir kez `supabase/setup/maintenance-cron.sql`
   dosyasını çalıştırın; dosya idempotenttir ve pg_cron yoksa hata vermeden uyarır.

   Yetki sınırını ve RLS'yi gerçek veritabanında doğrulamak için (Supabase CLI + Docker):

   ```bash
   npm run test:db
   ```

   Bu komut `supabase db reset` ile 0001'den itibaren tüm migration'ları temiz bir
   veritabanına uygular ve 73 pgTAP testini koşar. Gerçek JWT ile Data API sondası:

   ```bash
   npm run test:data-api
   ```

4. İlk yöneticiyi oluşturun:

   ```bash
   npm run admin:create
   ```

Supabase bilgileri eksikse bu komut **gerçek kullanıcı oluşturmuş gibi davranmaz**; hangi
değişkenlerin eksik olduğunu raporlar.

---

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run dev` | Geliştirme sunucusu |
| `npm run build` | Üretim derlemesi |
| `npm run start` | Üretim sunucusu |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript tip denetimi |
| `npm run test` | Birim ve güvenlik yüzeyi testleri (Vitest) |
| `npm run test:e2e` | Tarayıcı duman ve güvenlik testleri (Playwright, 390/768/1440 px) |
| `npm run test:db` | Veritabanı yetki sınırı + RLS testleri: temiz DB'ye 0001→0007 uygular, 73 pgTAP testi koşar (Supabase CLI + Docker) |
| `npm run test:data-api` | Gerçek anon / authenticated JWT ile PostgREST üzerinden yazma yüzeyinin kapalı olduğunu doğrular (yerel Supabase) |
| `npm run verify` | lint + typecheck + test + build + istemci paketi taraması |
| `npm run package:source` | Temiz kaynak paketi (`dist/Altin-Takip-Source.zip` + SHA-256 + manifest) |
| `npm run admin:create` | İlk yönetici hesabını oluşturur |
| `npm run admin:repair` | Eksik varsayılan portföy/tercih kayıtlarını idempotent biçimde tamamlar (yönetici onarımı) |
| `npm run icons` | PWA simgelerini koddan üretir |
| `npm run db:catalog` | Ürün kataloğunu SQL migration'ına yazar |

---

## Kullanıcı ve yönetici modeli

- **Kayıt yok.** Kullanıcıları yalnızca yönetici oluşturur.
- Yönetici geçici parola belirler; kullanıcı **ilk girişte parolasını değiştirmek zorundadır**.
- Yönetici hiçbir zaman mevcut parolayı göremez; yalnızca yeni geçici parola atayabilir.
- Parola sıfırlandığında veya hesap pasifleştirildiğinde **tüm cihazlardaki oturumlar düşer**.
- Varsayılan yönetim işlemi **pasifleştirmedir**. Kalıcı silme ayrı ve açık onay ister:
  hedefin kullanıcı adı birebir yazılmalıdır.
- `admin` rolü yalnızca `npm run admin:create` ile verilir; arayüzden verilemez.

Kullanıcı adı kuralları: 3–32 karakter, harf ile başlar, `a-z 0-9 . _ -` kullanılabilir, boşluk
içermez, büyük/küçük harfe duyarsızdır, Türkçe harfler ASCII karşılığına çevrilir
(`ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u`).

Parola kuralları: en az 10 karakter, en az bir harf ve bir rakam, yaygın/ardışık parolalar ve
kullanıcı adını içeren parolalar reddedilir.

---

## Fiyat verisi

Bu sürümde yalnızca `MockPriceProvider` kullanılır ve arayüzde **Test Verisi** olarak etiketlenir.

- Alış ve satış fiyatları birbirine çevrilmez; ayrı alanlardır.
- Bir sağlayıcı çalışmadığında başka bir piyasanın fiyatına sessizce geçilmez.
- Bayat veri "güncel" diye sunulmaz; son fiyat zamanı her zaman görünür.
- Hiçbir siteden izinsiz veri çekilmez. Gerçek fiyat entegrasyonu yalnızca lisanslı bir sağlayıcı
  sözleşmesiyle `LicensedPriceProvider` olarak eklenecektir.

---

## Oturum modeli: her cihazda bir kez giriş

Kullanıcılar sık sık yeniden giriş yapmaz. Giriş ekranında cihaz türü **sorulmaz**;
telefon, tablet ve bilgisayarda aynı, sade ve kalıcı oturum modeli kullanılır.

| Konu | Davranış |
| --- | --- |
| Oturum çerezi | Kalıcı; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, üretimde `__Host-` önekli |
| Ömür | 180 gün **kaydırmalı**: aktivitede bitiş sessizce ileri alınır (en fazla 24 saatte bir DB yazımı) |
| Kimlik yenileme | Oturum kimliği 7 günde bir sessizce yenilenir; eski kimlik 60 sn tolerans süresiyle geçerlidir |
| Hareketsizlik | **Otomatik çıkış yok.** 15 dk, 1 saat, 24 saat hareketsizlik oturumu kapatmaz |
| Tarayıcı/PWA/cihaz yeniden başlatma | Oturum devam eder |
| Aynı anda birden çok cihaz | Serbest; her cihaz ilk girişten sonra hesabı hatırlar |
| Normal "Çıkış" | Yalnızca bu cihazın oturumunu kapatır |
| "Tüm cihazlardan çıkış yap" | Ayarlar sayfasından; kullanıcının bütün oturumlarını iptal eder |

Oturumun zorunlu olarak kapandığı güvenlik olayları: kullanıcı kendi parolasını
değiştirirse **diğer** cihazlar kapanır; yönetici parolayı sıfırlarsa, hesabı
pasifleştirirse, oturumları iptal ederse veya hesap silinirse **bütün** cihazlar
kapanır. İptal edilmiş veya silinmiş bir oturum kimliği hiçbir istekte kabul edilmez.

Her cihazda:

- Oturum kimliği yalnızca `HttpOnly` çerezde taşınır; JavaScript ile okunamaz.
- Erişim/yenileme jetonu, parola veya dahili e-posta `localStorage` /
  `sessionStorage` / IndexedDB gibi JavaScript'ten okunabilir depolara **yazılmaz**.
- Portföy bulut veritabanında saklanır; mobil PWA ve masaüstü aynı portföyü gösterir.
- Servis çalışanı `/api/*` yanıtlarını ve kimliği doğrulanmış sayfaları önbelleğe almaz;
  internet yokken oturum varmış gibi yeni finansal işlem kabul edilmez.
- Bildirim, push, konum veya kamera izni istenmez; PWA kurulumu isteğe bağlıdır.

Yönetici, kullanıcının aktif oturumlarını cihaz etiketi (örn. "Chrome · Windows"),
giriş ve son görülme zamanıyla görür; tek oturumu veya tümünü kapatabilir.
Ham IP veya cihaz parmak izi **saklanmaz**.

Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md) bölüm 4, 12 ve 16.

## Güvenlik özeti

- **Yetkilendirme sınırı sunucudadır.** BFF, Supabase'e `service_role` ile bağlanır
  ve bu anahtar RLS'yi atlar; hangi satırın kime ait olduğunu markalanmış actor
  tipleri belirler. RLS, Data API'ye doğrudan erişime karşı ikinci katmandır.
  Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md) bölüm 14.
- **Geçici parolalı kullanıcı** portföy, işlem ve yönetim uçlarını kullanamaz
  (`PASSWORD_CHANGE_REQUIRED`).
- **Oturum sunucuda yönetilir:** 180 gün kaydırmalı ömür, 7 günde bir sessiz kimlik
  yenileme, iptal listesi. Hareketsizlik zaman aşımı yoktur; oturumu yalnızca açık
  çıkış veya güvenlik olayları kapatır.
- **Veritabanı yetki sınırı (0006):** anon/authenticated rolleri kişisel ve finansal
  tablolara **doğrudan yazamaz** (INSERT/UPDATE/DELETE grant'ı yok); kritik
  SECURITY DEFINER RPC'ler yalnızca `service_role` ile çağrılır. Finansal mutation
  yalnızca BFF + kontrollü RPC yolundan geçer. GRANT ve RLS iki ayrı katmandır ve
  73 pgTAP testi + gerçek JWT sondası ile yerel Supabase'de doğrulanmıştır.
- **Üretim sertleştirme:** `APP_ORIGIN` zorunlu (Host'tan türetilmez),
  `TRUSTED_PROXY_PROVIDER` ile `X-Forwarded-For` yalnızca güvenilir vekilde okunur,
  ham IP hiçbir yere yazılmaz, giriş hız sınırı IP / kullanıcı adı / kombinasyon
  olmak üzere üç ayrı sayaçla uygulanır.
- **CSRF:** durum değiştiren her istek `Origin` + `Sec-Fetch-Site` ve imzalı
  senkronizasyon jetonu ile korunur; jeton hiçbir tarayıcı deposuna yazılmaz.
- **Hız sınırlayıcı** üretimde Postgres'te paylaşılır; yapılandırma eksikse
  sessizce zayıf moda düşülmez.
- **Veritabanı bütünlüğü:** kullanıcı başına tek portföy, portföy sahipliği
  composite foreign key ile zorlanır, birim kataloğa uyar ve aşırı satış
  eşzamanlı isteklerde de atomik olarak engellenir.
- **Denetim kayıtları** tetikleyici düzeyinde değiştirilemez.

## Teslim paketi

```bash
npm run package:source
```

`dist/Altin-Takip-Source.zip` üretir; yanında SHA-256 ve dosya manifesti oluşturur.
Pakete `.git`, `node_modules`, `.next`, `.data`, test çıktıları ve gerçek `.env`
dosyaları **girmez**. Komut paketi yeniden açıp secret taraması yapar; iz bulursa
paketi siler ve hata verir.

## Demo modu

Demo modu yalnızca **geliştirme ortamında** ve `NEXT_PUBLIC_ENABLE_DEMO_MODE=true` iken `/demo`
adresinde açılır. Üretim derlemesinde 404 döner ve giriş ekranında hiçbir demo bağlantısı görünmez.
Demo verileri yalnızca tarayıcının IndexedDB deposunda tutulur, sunucuya gitmez ve cihazlar arasında
senkronize olmaz.

---

## Belgeler

| Belge | İçerik |
| --- | --- |
| [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Ürün gereksinimleri ve kapsam |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Katmanlar, kimlik doğrulama akışı, dosya haritası |
| [docs/SECURITY.md](docs/SECURITY.md) | Kimlik doğrulama, yetkilendirme, RLS, denetim kaydı |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tablolar, ilişkiler, indeksler |
| [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md) | Kabul kriterleri ve karşılık gelen testler |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Sonraki sprintler |
| [CLAUDE.md](CLAUDE.md) | Bu depoda çalışan yapay zekâ ajanları için kurallar |
