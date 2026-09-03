# Altın Takip

Türkiye'deki altın portföylerini telefonda, tablette ve bilgisayarda tek yerden takip etmek için
geliştirilen responsive web uygulaması ve PWA.

- Kurulum gerektirmez: tarayıcıda çalışır, ana ekrana uygulama olarak eklenebilir.
- EXE, MSI, BAT, tarayıcı eklentisi veya yerel yardımcı yoktur; şirket bilgisayarlarında
  hiçbir program kurmadan kullanılır. PWA kurulumu tamamen isteğe bağlıdır.
- Excel, Python veya yönetici izni gerekmez.
- Hesaplar **yalnızca yönetici tarafından** oluşturulur; herkese açık kayıt yoktur.
- Giriş **kullanıcı adı + parola** iledir. E-posta, telefon, OTP veya sihirli bağlantı kullanılmaz.
- Fiyatlar için lisanslı bir kaynak **yoktur**. Özel pilotta yalnızca Kayseri ekran
  gözlemi ve sınırlı sayıda ürün canlıdır; desteklenmeyen üründe fiyat **uydurulmaz**,
  açık uyarı gösterilir. Ayrıntı: [docs/PRICE_SOURCE_STATUS.md](docs/PRICE_SOURCE_STATUS.md).

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
   0008_session_policy.sql        -> "oturumumu açık tut" tercihi; tarayıcı oturumu / admin sınırları
   0009_portfolio_accounting.sql  -> işlem defteri sütunları, price_snapshots, portfolio_positions,
                                     defter koruma tetikleyicileri, idempotency indeksi
   0010_accounting_rpc.sql        -> atomik defter RPC'leri (ekle / iptal / düzelt / doğrula)
   0011_accounting_integrity.sql  -> service_role doğrudan yazma izinlerinin kaldırılması,
                                     köken ayrımı, girilen/efektif fiyat, occurred_at, snapshot kısıtları
   0012_staging_sync.sql          -> defter sürümü (cihazlar arası senkronizasyon), sayısal sınırlar,
                                     sıkı ayrıştırma, snapshot zaman kuralları, replace replay biçimi
   ```

   Bakım görevleri (pg_cron) için ayrıca bir kez `supabase/setup/maintenance-cron.sql`
   dosyasını çalıştırın; dosya idempotenttir ve pg_cron yoksa hata vermeden uyarır.

   Yetki sınırını ve RLS'yi gerçek veritabanında doğrulamak için (Supabase CLI + Docker):

   ```bash
   npm run test:db
   ```

   Bu komut `supabase db reset` ile 0001'den itibaren tüm migration'ları temiz bir
   veritabanına uygular ve 184 pgTAP testini koşar. Gerçek JWT ile Data API sondası:

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
| `npm run test:db` | Veritabanı yetki sınırı, RLS ve muhasebe testleri: temiz DB'ye 0001→0016 uygular, 242 pgTAP testi koşar (Supabase CLI + Docker) |
| `npm run test:data-api` | Gerçek anon / authenticated JWT ile PostgREST üzerinden yazma yüzeyinin kapalı olduğunu doğrular (yerel Supabase) |
| `npm run verify` | lint + typecheck + test + build + istemci paketi taraması |
| `npm run package:source` | Temiz kaynak paketi (`dist/Altin-Takip-Source.zip` + SHA-256 + manifest) |
| `npm run admin:create` | İlk yönetici hesabını oluşturur |
| `npm run admin:repair` | Eksik varsayılan portföy/tercih kayıtlarını idempotent biçimde tamamlar (yönetici onarımı) |
| `npm run accounting:verify` | Defteri yeniden oynatır; türetilmiş pozisyonlar ve Postgres içi doğrulamayla karşılaştırır; tutarsızlıkta başarısız olur |
| `npm run price:contract` | Sağlayıcı sözleşmesi testleri (fixture). Credential varsa canlı sağlık kontrolü ekler; yoksa eksik DEĞİŞKEN ADLARINI listeleyip NOT_RUN raporlar |
| `npm run price:sarraf-feasibility` | Sarraf TV Kayseri ekranının normal tarayıcı oturumunda okunup okunamadığını ölçen DENEYSEL fizibilite aracı. Üretim yolunun parçası değildir; CAPTCHA aşmaz, sonucu OK/BLOCKED/UNAVAILABLE/NOT_RUN olarak dürüstçe raporlar |
| `npm run price:smoke` | Yalnızca yerel Supabase: katalog eşitleme → alım → karantina → kaynak seçimi yolunu uçtan uca doğrular |
| `npm run accounting:smoke` | Yalnızca yerel Supabase: gerçek RPC yolundan kabul örneklerini (1, 4, 8, 9, VOID/REPLACE, MARKET_BASELINE) koşar |
| `npm run staging:doctor` / `staging:migrate` / `staging:smoke` / `staging:seed` / `staging:admin` / `staging:cleanup` / `test:staging` | Staging araçları — bkz. [docs/STAGING.md](docs/STAGING.md). Değerler yazdırılmaz; eksik yapılandırmada fail closed |
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

Uygulama **çoklu fiyat kaynağını** destekler. Bu sürümde hiçbir gerçek sağlayıcı lisansı
yoktur: yalnızca **Test Verisi** çalışır ve arayüzde "Gerçek piyasa verisi değil" etiketiyle
görünür. Gerçek kaynaklar katalogda tanımlıdır ama `NOT_CONFIGURED` / `LICENSE_REQUIRED`
durumundadır ve veri çekmez.

| Kaynak | Piyasa | Durum |
| --- | --- | --- |
| Test Verisi (MARKET_BASELINE) | Test | Yalnızca geliştirme; üretimde kapalı |
| Sarraf TV Kayseri (ekran gözlemi) | Kayseri | **Özel pilot** — `EXPERIMENTAL_PRIVATE`, lisanssız, izin listesiyle, sınırlı ürün |
| Kayseri Yerel Piyasa (Sarraf Pro — KAYSARDER ekranı) | Kayseri | Yetkili API/XML sözleşmesi bekleniyor |
| AltinAPI — bağımsız veri sağlayıcısı | Genel Türkiye | Anahtar ve lisans bekleniyor |
| Hasfiyat — çoklu kaynak | Çoklu Kaynak | Anahtar ve lisans bekleniyor |
| Altınkaynak / Harem (doğrudan) | Genel Türkiye | Resmî sözleşme yok; adapter kapalı |
| BIST Referans | BIST | Yalnızca anomali kontrolü; değerlemede kullanılamaz |

- Alış ve satış fiyatları birbirine çevrilmez; ayrı alanlardır.
- Bir sağlayıcı çalışmadığında başka bir piyasanın fiyatına **sessizce geçilmez**.
- Bayat veri "güncel" diye sunulmaz; son fiyat zamanı her zaman görünür.
- CAPTCHA aşılmaz, bot koruması atlatılmaz, gizli WebSocket reverse engineer edilmez.
  Ekran gözlemi kaynağı normal tarayıcı oturumunda görünen değerleri okur; ticari yayın
  hakkı vermez ve "resmî API" olarak etiketlenmez.
- Fiyatlar merkezî sunucu alımıyla toplanır (varsayılan 60 sn); tarayıcı sağlayıcıya bağlanmaz.
- API anahtarları yalnızca sunucudadır; istemci paketine veya veritabanına girmez.
- Kaynak değişimi geçmiş işlem maliyetlerini, `MARKET_BASELINE` snapshot'larını ve gerçekleşmiş
  kâr/zararı değiştirmez; yalnızca güncel değerlemeyi etkiler ve açık onay ister.

Ayrıntı, katalog ve bir kaynağı üretimde açma adımları: [docs/PRICE_PROVIDERS.md](docs/PRICE_PROVIDERS.md).
Pilotta hangi ürünün gerçekten çalıştığı ve neyin çalışmadığı:
[docs/PRICE_SOURCE_STATUS.md](docs/PRICE_SOURCE_STATUS.md).

---

## Oturum modeli: "Bu cihazda oturumumu açık tut"

Giriş ekranında tek bir tercih vardır; cihaz türü sorulmaz.

| Durum | Çerez | Sunucu sınırı |
| --- | --- | --- |
| Kutu **işaretli** | Kalıcı (`__Host-`, HttpOnly, Secure, SameSite=Lax) | 180 gün **kaydırmalı** ömür (bitiş ≤ 24 saatte bir ileri alınır), kimlik 7 günde bir sessizce yenilenir; yalnızca açık çıkış veya güvenlik olayıyla kapanır |
| Kutu **işaretsiz** (varsayılan) | Tarayıcı oturumu çerezi (kapanınca silinir) | En fazla **8 saat** mutlak ömür, **30 dakika** hareketsizlik |
| **Yönetici** hesabı | Her zaman tarayıcı oturumu çerezi | Tercihten bağımsız en fazla **8 saat** mutlak, **15 dakika** hareketsizlik; asla kalıcı değil |

- Tercih `localStorage`/`sessionStorage`'a yazılmaz; sunucudaki oturum kaydında (`persistent`) tutulur.
- Mevcut 180 günlük kullanıcı oturumları "kalıcı tercih verilmiş" kabul edilir ve geçersiz kılınmaz;
  mevcut admin oturumları migration ile 8 saat / 15 dakika sınırına çekilir.
- Normal "Çıkış" yalnızca bu cihazı kapatır; Ayarlar'daki "Tüm cihazlardan çıkış yap" bütün oturumları
  iptal eder. Parola sıfırlama, pasifleştirme, yönetici iptali ve hesap silme bütün cihazları kapatır.
- Oturum kimliği yalnızca `HttpOnly` çerezde taşınır; erişim/yenileme jetonu, parola veya dahili
  e-posta tarayıcı deposuna yazılmaz. Süresi dolan kayıtlar `purge_expired_sessions()` ile temizlenir.

Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md) bölüm 4 ve 16.

## Muhasebe modeli (özet)

Yöntem **ürün bazlı hareketli ağırlıklı ortalama maliyet**; kaynak gerçek **append-only işlem
defteri**dir (kayıt silinmez; iptal edilir veya düzeltilir). Üç akış: **Mevcut Altını Ekle**
(gerçek / tahmini maliyet veya "bugünden itibaren takip et" = piyasa başlangıç değeri),
**Yeni Alış Ekle** (birim fiyat + masraflar veya toplam ödenen tutar) ve **Satış Ekle**
(birim satış fiyatı veya net tahsilat). Bütün miktar ve tutarlar ondalık dize olarak taşınır;
hesaplar `decimal.js` ve PostgreSQL `numeric` ile yapılır. Her mutation atomik RPC'den geçer
(veritabanı `service_role`'e bile doğrudan tablo yazımı vermez), eşzamanlı satış eldeki miktarı
aşamaz, aynı `clientRequestId` ile tekrar gönderim ikinci kayıt oluşturmaz. Girilen birim fiyat
ile masraflar dâhil efektif maliyet ayrı saklanır; işlemlere isteğe bağlı saat girilerek aynı
gün içindeki gerçek sıra korunur (Europe/Istanbul). Aynı hesap telefon ve bilgisayarda
açıkken bir cihazdaki değişiklik diğerinde sayfa yenilenmeden ≤ 15 sn içinde görünür
(defter sürümü + hafif sürüm sorgusu). Ayrıntı ve örnek hesaplar:
[docs/ACCOUNTING_MODEL.md](docs/ACCOUNTING_MODEL.md).

> Bu uygulama vergi, muhasebe veya yatırım danışmanlığı hizmeti değildir; girilen verilere ve
> bilgilendirme amaçlı (bu sürümde test) fiyatlara dayalı bir portföy takip aracıdır.

## Güvenlik özeti

- **Yetkilendirme sınırı sunucudadır.** BFF, Supabase'e `service_role` ile bağlanır
  ve bu anahtar RLS'yi atlar; hangi satırın kime ait olduğunu markalanmış actor
  tipleri belirler. RLS, Data API'ye doğrudan erişime karşı ikinci katmandır.
  Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md) bölüm 14.
- **Geçici parolalı kullanıcı** portföy, işlem ve yönetim uçlarını kullanamaz
  (`PASSWORD_CHANGE_REQUIRED`).
- **Oturum sunucuda yönetilir:** "oturumumu açık tut" işaretliyse 180 gün kaydırmalı
  ömür ve 7 günde bir sessiz kimlik yenileme; işaretsizse 8 saat / 30 dk; admin için
  her zaman 8 saat / 15 dk. Güvenlik olayları bütün cihazları kapatır.
- **Muhasebe defteri:** finansal kayıtlar yalnızca eklenir ya da VOID/REPLACED olur;
  pozisyonlar atomik RPC içinde defterden yeniden oynatılır; idempotency anahtarı
  çift gönderimi engeller; türetilmiş pozisyon tablosuna `service_role` bile elle yazamaz.
- **Veritabanı yetki sınırı (0006):** anon/authenticated rolleri kişisel ve finansal
  tablolara **doğrudan yazamaz** (INSERT/UPDATE/DELETE grant'ı yok); kritik
  SECURITY DEFINER RPC'ler yalnızca `service_role` ile çağrılır. Finansal mutation
  yalnızca BFF + kontrollü RPC yolundan geçer. GRANT ve RLS iki ayrı katmandır ve
  242 pgTAP testi + gerçek JWT sondası (46 beklenti) ile yerel Supabase'de doğrulanmıştır.
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
- **Yönetici ikinci faktörü (TOTP) zorunludur.** Doğrulanmamış oturum yönetim uçlarında
  reddedilir; secret dinlenmede AES-256-GCM ile şifrelidir, kurtarma kodları yalnızca özet
  olarak saklanır ve tek kullanımlıktır. Sıfırlama yalnızca başka bir yönetici tarafından,
  kullanıcı adı onayıyla yapılır ve hedefin oturumlarını kapatır.
- **Fiyat sağlayıcı anahtarları yalnızca sunucudadır;** istemci paketine, veritabanına veya
  loglara girmez. Sağlayıcı hataları sabit güvenli kodlara indirgenir. Lisans kapısı fail
  closed'dır: izin açıkça verilmedikçe kaynak veri çekmez ve etkinleştirilemez.
- **Sağlık kontrolü** `GET /api/health` ile yapılır. Kimliksiz yanıt yalnızca ayakta/erişilebilir
  bilgisini verir; sağlayıcı ayrıntısı için operatör secret'ı gerekir.
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
| [docs/ACCOUNTING_MODEL.md](docs/ACCOUNTING_MODEL.md) | Hareketli ağırlıklı ortalama, açılış bakiyesi, K/Z, decimal ve iptal/düzeltme politikası |
| [docs/PRICE_PROVIDERS.md](docs/PRICE_PROVIDERS.md) | Fiyat sağlayıcı kataloğu, lisans kapısı, merkezî alım ve kaynak seçimi |
| [docs/PRICE_RUNTIME_INTEGRITY.md](docs/PRICE_RUNTIME_INTEGRITY.md) | Fiyat çalışma zamanı bütünlüğü: makine ucu, devre kesici, karantina, varsayılan kaynak, TOTP replay |
| [docs/SARRAF_TV_FEASIBILITY.md](docs/SARRAF_TV_FEASIBILITY.md) | Sarraf TV Kayseri ekran fizibilitesi (araç tarafından otomatik üretilir) |
| [docs/RUNBOOKS.md](docs/RUNBOOKS.md) | Sağlayıcı kesintisi, karantina, yedekleme/geri yükleme, MFA kurtarma, sağlık kontrolü |
| [docs/STAGING.md](docs/STAGING.md) | Staging kurulumu, araçlar, telefon–PC senkronizasyonu |
| [docs/FINAL_DEPLOYMENT.md](docs/FINAL_DEPLOYMENT.md) | Özel pilotu sıfırdan ayağa kaldırma adımları |
| [docs/ADMIN_QUICK_START.md](docs/ADMIN_QUICK_START.md) | Yönetici: hesap açma, MFA, izin listesi, eşleme onayı |
| [docs/USER_QUICK_START.md](docs/USER_QUICK_START.md) | Kullanıcı: giriş, işlem girme, K/Z, fiyat uyarıları |
| [docs/PRICE_SOURCE_STATUS.md](docs/PRICE_SOURCE_STATUS.md) | Fiyat kaynaklarının ölçülmüş durumu ve sınırları |
| [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md) | Belirti → neden → yapılacak: worker, karantina, geri alma |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Sonraki sprintler |
| [CLAUDE.md](CLAUDE.md) | Bu depoda çalışan yapay zekâ ajanları için kurallar |
