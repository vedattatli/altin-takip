# Bu depoda çalışırken uyulacak kurallar

Bu dosya, projede çalışan yapay zekâ ajanları ve geliştiriciler için bağlayıcı kurallardır.

## Çalışma biçimi

- **Alt ajan, Task agent, agent team, paralel ajan veya worktree kullanma.** Bütün inceleme,
  planlama, kodlama ve testleri doğrudan yap.
- **Başka ajanlara görev devretme.** İşi bölme, tek elden yürüt.
- Gereksiz yeniden yazım yapma. Mevcut mimariyi bozmadan uyarla.
- Gereksiz bağımlılık ekleme. Yeni paket eklemeden önce standart kütüphane veya mevcut kodla
  çözülüp çözülemeyeceğine bak.
- Uzun teorik açıklama yerine dosyayı yaz, kodu çalıştır, sonucu doğrula.

## Her değişiklikten sonra

```bash
npm run verify
```

Bu komut sırayla `lint`, `typecheck`, `test`, `build` ve `verify:bundle` çalıştırır.
Beşi de geçmeden işi tamamlanmış sayma. Arayüzü veya güvenlik katmanını etkileyen
değişikliklerde ayrıca:

```bash
npm run test:e2e
```

Veritabanı politikalarını değiştirdiysen (ortam destekliyorsa):

```bash
npm run test:db
```

## Güvenlik kuralları (ihlal edilemez)

- **Secret commit etme.** `.env.local`, gerçek anahtarlar, parolalar, tokenlar asla depoya girmez.
  Yalnızca `.env.example` commit edilir ve içinde gerçek değer bulunmaz.
- **`SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` istemciye gönderilmez.** Bu anahtara yalnızca
  `src/server/` altındaki `import "server-only"` işaretli modüller erişebilir. `NEXT_PUBLIC_` öneki
  verilmesi yasaktır; API yanıtına veya istemci paketine girmez (`npm run verify:bundle`).
- **Kendi parola hash sistemini yazma.** Üretimde parola custody'si Supabase Auth'a aittir.
  Uygulama tablolarında `password`, `password_hash` gibi bir sütun oluşturma.
  (Tek istisna: `src/server/auth/local-backend.ts` — yalnızca geliştirme test ikizidir ve üretimde
  hata fırlatır. Yeni kod bu deseni örnek almamalıdır.)
- **Kullanıcı izolasyonunu RLS ile koru.** Yeni tablo eklerken `enable row level security` +
  `force row level security` ve `user_id = auth.uid()` politikaları yazılmadan migration
  tamamlanmış sayılmaz. `user_id` ve RLS'de filtrelenen alanlara indeks ekle.
- **Rol istemciden alınmaz.** Hiçbir API ucu gövdeden `role` kabul etmez. `admin` rolü yalnızca
  `npm run admin:create` ile verilir.
- **Yetki kontrolü sunucuda yapılır.** Menü gizlemek güvenlik önlemi değildir; her admin ucu
  `requireCurrentAdmin()` çağırmak zorundadır.
- **Yönetici kullanıcının FİNANSAL verisini göremez (ihlal edilemez).** Altın miktarı, tutar,
  ortalama maliyet, kâr/zarar ve işlem geçmişi yönetici yüzeyine ÇIKMAZ. Yönetici hesabı
  yönetir (açma, arama, pasifleştirme, silme, parola sıfırlama) ve hesabın yaşam döngüsünü
  görür (son giriş, açık oturumlar, cihaz etiketi). `AdminService` içinde `listLedger`,
  `listPositions`, `valuePositions` veya `adminScope` KULLANMA; portföy okuyan yeni bir
  yönetici ucu EKLEME. Bu kural `tests/admin-service.test.ts` ve
  `tests/authorization-matrix.test.ts` tarafından denetlenir.
- **Denetim kaydına hassas veri yazma.** `admin_audit_logs` içine parola, parola özeti, tutar veya
  işlem detayı yazılmaz.
- **Herkese açık kayıt AÇIKTIR** (`/kayit`, `POST /api/auth/register`). Ürün kararı sahibi
  tarafından verildi: siteye giren herkes kendi hesabını açar. Uç internete açık olduğu için
  korumalar gevşetilemez: giriş ucuyla AYNI hız sınırlayıcı, kullanıcı adı doğrulama,
  ayrılmış ad reddi, benzersizlik ve parola politikası. **Rol istemciden ALINMAZ**; kayıt
  her zaman `user` rolüyle açılır.
- **E-posta OTP, sihirli bağlantı, telefon girişi, `signInWithOtp`, `resetPasswordForEmail`
  kullanma.** Uygulamanın e-posta/SMS kanalı yoktur; bu yüzden "şifremi unuttum" akışı da
  YOKTUR. Parola sıfırlamayı yalnızca yönetici yapar (`/yonetim`). Kimliği doğrulanmamış bir
  sıfırlama akışı EKLEME: kullanıcı adını bilen herkes hesabı ele geçirir.

## Dağıtım ve cihaz kuralları

- **Yerel kurulum gerektiren hiçbir şey üretme:** EXE, MSI, BAT, PowerShell betiği, tarayıcı
  eklentisi, native helper, Electron/Tauri kabuğu. Uygulama normal HTTPS web uygulamasıdır.
- **PWA kurulumunu zorunlu kılma.** Hiçbir özellik `display-mode: standalone` kontrolüne veya
  servis çalışanına bağlı olamaz. `beforeinstallprompt` yalnızca bastırmak için kullanılır;
  `prompt()` çağrılmaz.
- **Parola veya oturum jetonunu JavaScript'ten okunabilir depoya yazma.** `localStorage`,
  `sessionStorage` ve `document.cookie` uygulama kodunda kullanılmaz. Oturum yalnızca
  `Secure` + `HttpOnly` + `SameSite=Lax` çerezle taşınır.
- **Oturum modelini bozma:** cihaz türü seçimi, istemci tarafı hareketsizlik sayacı veya
  istemci tarafı otomatik çıkış EKLEME. Tek tercih "Bu cihazda oturumumu açık tut" kutusudur;
  süre sınırları yalnızca sunucuda uygulanır. Kalıcı oturum yalnızca açık çıkış veya güvenlik
  olayıyla (parola sıfırlama, pasifleştirme, yönetici iptali, silme) kapanır. Cihaz izni istenmez.
- **Servis çalışanına hassas yanıt yazma.** `/api/*` ve kimliği doğrulanmış sayfa yanıtları
  önbelleğe alınmaz.
- Kullanıcı portföyü bulut veritabanında saklanır; cihazlar arası senkronizasyon sunucu
  üzerinden yapılır.

## Yetkilendirme sınırı (ihlal edilemez)

- **BFF içinde RLS UYGULANMAZ.** Sunucu Supabase'e `service_role` ile bağlanır ve
  bu anahtar RLS'yi atlar. Birincil güvenlik sınırı **sunucu tarafı actor
  authorization**'dır; RLS ikinci katmandır. Dokümanda "veriler RLS ile
  korunuyor" gibi belirsiz bir ifade kullanma.
- **Veri metotlarına ham `userId` geçirme.** Arka uç metotları markalanmış
  `DataScope` alır. Kapsam yalnızca `ownScope(actor)` veya
  `adminScope(admin, targetId)` ile üretilir.
- **Normal kullanıcı uçları hedef kullanıcı kimliği kabul etmez.** Kimlik her
  zaman doğrulanmış oturumdan türetilir; gövde, sorgu veya route parametresinden
  ASLA okunmaz.
- **Başka kullanıcıyı hedefleyen işlemler `AdminService`'tedir** ve
  `requireCurrentAdmin()` zorunludur. Her erişim denetim kaydı üretir.
- Yeni bir API ucu eklerken `tests/authorization-matrix.test.ts` içindeki guard
  tablosunu da güncelle; aksi hâlde test başarısız olur.

## Guard seçimi

| Guard | Ne zaman |
| --- | --- |
| `requireAuthenticatedUser` | YALNIZCA `/api/auth/session`, `/logout`, `/logout-all`, `/change-password` |
| `requireUsableUser` | Kullanıcının kendi verisiyle ilgili her uç |
| `requireCurrentAdmin` | Yönetim uçları |

Geçici parolalı kullanıcı `requireUsableUser` ve `requireCurrentAdmin`
guard'larından **geçemez**; `PASSWORD_CHANGE_REQUIRED` ile reddedilir.
Arayüz yönlendirmesine tek başına güvenme.

## CSRF ve route sarmalayıcısı

- **Her API route'u `apiRoute()` ile sarılır.** Ham `export async function POST`
  yazma; sarmalayıcı hem CSRF/origin kontrolünü hem hata dönüşümünü yapar.
- Durum değiştiren isteklerde `Origin` + `Sec-Fetch-Site` + imzalı CSRF jetonu
  doğrulanır. İstemci tarafında `apiFetch()` kullan; ham `fetch` ile mutation
  yapma (jeton eklenmez).
- CSRF jetonunu `localStorage`/`sessionStorage`'a yazma. Jeton `<meta>` ile
  taşınır, eşi `HttpOnly` çerezdedir.

## Oturum modeli (tercihe bağlı: kalıcı / tarayıcı oturumu / admin)

- Giriş ekranında tek kutu: "Bu cihazda oturumumu açık tut" (`keepSignedIn`). İşaretli →
  kalıcı çerez + 180 gün kaydırmalı; işaretsiz → tarayıcı oturumu çerezi + 8 saat / 30 dk;
  admin → her zaman 8 saat / 15 dk, ASLA kalıcı değil (`sessionPolicyFor`).
- Tercihi tarayıcı deposuna yazma; oturum kaydındaki `persistent` alanı tek kaynaktır.
- Süre kontrolü **sunucudadır**; istemcide sayaç YOKTUR.
- 180 gün kaydırmalı ömür (`SESSION_ROLLING_LIFETIME_MS`); bitiş en fazla 24 saatte bir,
  `last_seen_at` en fazla 15 dakikada bir yazılır. Her istekte DB yazma.
- Oturum kimliği 7 günde bir `commitSessionCookie()` ile sessizce yenilenir; eski kimlik
  60 sn tolerans süresiyle kabul edilir. Hiç bitmeyen / hiç değişmeyen jeton üretme.
- Çerez kalıcıdır (`expires` = sunucudaki bitiş); `__Host-` öneki, HttpOnly, Secure, SameSite=Lax.
- Normal çıkış yalnızca mevcut oturumu siler; `logout-all` ve yönetici iptali hepsini.
  Çıkış uçlarında `markSessionEnded()` çağır ki istek sonunda çerez yeniden yazılmasın.
- `device_mode` ve `idle_expires_at` deprecated'dır; yetkilendirme kararında KULLANMA.
- Oturum kaydına ham IP, User-Agent veya parmak izi yazma; yalnızca `describeDevice()` etiketi.

## Hız sınırlayıcı ve istemci IP'si

- Üretimde **paylaşımlı (Postgres)** sınırlayıcı zorunludur. Yapılandırma
  eksikse bellek sınırlayıcısına **sessizce düşme**; açık yapılandırma hatası ver.
- Giriş üç sayaçtan geçer: IP, kullanıcı adı, IP+kullanıcı adı (`loginRateLimitBuckets`).
  Başarılı girişte yalnızca kombinasyon sayacını sıfırla.
- Anahtarı ham saklama; `RATE_LIMIT_PEPPER` ile HMAC'le. Ham IP hiçbir loga/tabloya yazılmaz.
- `X-Forwarded-For`'u doğrudan okuma; `resolveClientIp()` + `TRUSTED_PROXY_PROVIDER` kullan.
- Sınırlayıcı sorgusu hata verirse isteği geçirme (fail closed).
- Üretimde `APP_ORIGIN` zorunludur; Host başlığından origin türetme.

## Veritabanı değişiklikleri

- Mevcut migration dosyalarını **düzenleme**; yeni numaralı dosya ekle.
- Kısıt eklerken mevcut veriyle çakışma olup olmadığını önce kontrol et ve
  gerekiyorsa açık bir hata ile durdur.
- Finansal yazma yollarında aşırı satış kontrolü **atomik** olmalıdır
  (portföy satırı kilidi + aynı transaction içinde doğrulama).
- Denetim kayıtlarını değiştirilebilir hâle getirme; tetikleyici korumasını kaldırma.
- **Yeni SQL fonksiyonu eklerken yetkilerini açıkça ayarla:** tam imzayla `revoke all ... from
  public, anon, authenticated`; yalnızca BFF'nin çağıracağı üst seviye RPC'ye `grant execute ... to
  service_role`. Dahili yardımcı ve tetikleyici fonksiyonlarına hiçbir role grant verme.
- **anon/authenticated rollerine INSERT/UPDATE/DELETE grant'ı verme**; Data API yalnızca RLS
  kapsamlı SELECT içindir. Finansal mutation yalnızca BFF + `*_transaction_checked` RPC yoluyla.
- `GET` yolları veri OLUŞTURMAZ; varsayılan kayıtlar provisioning tetikleyicisi/onarımı ile hazırlanır.
- Politika ve grant değişikliğinden sonra `supabase/tests/rls.test.sql` planını güncelle ve
  `npm run test:db` çalıştır (yerel Supabase: `npx supabase start`).

## Muhasebe kuralları (ihlal edilemez)

- **Finansal hesapta `number` kullanma.** Miktar/tutar API'de ondalık DİZE, motorda
  `decimal.js` (`src/domain/accounting`), veritabanında `numeric`. `decimal.js`'te
  `isPositive()` sıfır için de true döner; `> 0` için `greaterThan(0)` kullan.
- **Defter kaynak gerçektir.** Kayıt silme/güncelleme yok; yalnızca `ledger_append`,
  `ledger_void`, `ledger_replace` RPC'leri. `transactions`, `price_snapshots` ve
  `portfolio_positions` tablolarına uygulama kodundan `.from()` ile ERİŞME; veritabanı
  `service_role`'e bile doğrudan yazma izni vermez (0011) ve statik test bunu denetler.
- **Girilen fiyat ile efektif maliyeti karıştırma:** `quotedAcquisitionUnitPrice` kullanıcının
  girdiği (masraf hariç) fiyattır; `effectiveAcquisitionUnitCost = totalPaid / quantity`.
  TOTAL_AMOUNT modunda girilen fiyat UYDURULMAZ (null). "Birim alış fiyatı" etiketiyle
  efektif maliyet gösterme.
- **Köken bayrakları iki kümedir:** `holdingCostOrigins` (elde kalan; miktar sıfıra inince
  sıfırlanır) ve `realizedPnlOrigins` (tarihsel; silinmez). K/Z etiketi ikisine birden bakar.
- **İşlem zamanı Europe/Istanbul'dur:** tarih gerçek takvim günü olmalı (2026-02-30 ret),
  saat isteğe bağlı; sıralama `occurredAtInstant`/`occurred_at`, `createdAt`, `ledgerSequence`, `id`.
  Saat girilmeyen kayıt günün başlangıcıdır. Sunucu yerel saatine göre "bugün" hesaplama;
  `todayISO()` kullan.
- **Sayı ayrıştırıcıyı gevşetme:** iç boşluk ("1 2") ve belirsiz tek üçlü grup ("5.000")
  reddedilir; formlar düzeltme değerlerini `toInputDecimal` ile (virgüllü) yükler.
- **Quote kullanılabilirliğine yalnızca `validateUsableQuote` karar verir** (`src/prices/validate.ts`);
  değerleme, MARKET_BASELINE ve demo defteri aynı fonksiyonu kullanır. Arayüz kararları
  `summary.valuationStatus` ve `summary.portfolioState` ile verilir; `priceStatus` yalnızca
  sağlayıcı meta bilgisidir.
- **Sayısal üst sınır 12 tam basamaktır** (tutar, türetilmiş birim değer, birikimli pozisyon);
  TS (`MAX_AMOUNT`) ve SQL (`ledger_compute_amounts` / `ledger_replay_product`) birlikte
  değiştirilmelidir.
- **Defter sürümünü elle artırma:** `ledger_bump_revision` yalnızca defter RPC'leri içinde;
  replay ve başarısız işlem sürümü artırmaz. Senkronizasyon `GET /api/portfolio/version`
  polling'idir; Supabase access token tarayıcıya çıkarılmaz.
- **Staging secretları:** `.env.staging.local` ve `.staging/` gitignore + paket dışıdır; staging
  betikleri değer yazdırmaz; eksik yapılandırmada fail closed. Kimlik doğrulamayı kullanıcı
  interaktif yapar (`npx supabase login`, `npx vercel login`, `gh auth login`).
- **Her mutation `clientRequestId` kabul etsin;** aynı içerik replay, farklı içerik 409.
- Kullanıcının gerçek işlem fiyatı esastır; piyasa fiyatı maliyeti değiştirmez.
  `MARKET_BASELINE` fiyatını yalnızca sunucu sağlayıcısından al; istemci fiyatını yok say.
- Fiyat yok/bayat/geçersizse değerlemeyi hesaplanmış gibi gösterme; başka üründen tahmin yapma.
- "Hayat boyu toplam kâr", "kesin kâr", "vergiye esas kâr" ifadelerini kullanma.
- Motoru değiştirirsen `tests/accounting.test.ts`, pgTAP muhasebe bölümü ve
  `0010_accounting_rpc.sql` (`ledger_replay_product`) birlikte güncellenmeli;
  `npm run accounting:verify` ve `npm run accounting:smoke` (yerel Supabase) çalıştır.
- CLI betikleri (`admin:*`, `accounting:*`) `server-only` stub'ı ile çalışır
  (`scripts/node-server-only-stub.cjs`); uygulama kodunda bu stub'ı kullanma.

## Teslim paketi

- Build/cache dosyalarını depoya ekleme (`.next`, `node_modules`, `.data`,
  `dist`, `test-results`, tsbuildinfo).
- Kaynak paketi `npm run package:source` ile üretilir; komut secret taraması
  yapar ve iz bulursa paketi siler.

## Fiyat verisi kuralları

- **Gerçek fiyat entegrasyonunu lisans/izin olmadan scrape ederek yapma.** KAYSARDER, Sarraf TV,
  Altınkaynak veya Harem sayfalarından izinsiz veri çekme; CAPTCHA/bot korumasını aşma; gizli veya
  özel WebSocket uçlarını reverse engineer etme.
- **Hayali endpoint yazma.** Sözleşmesi bilinmeyen sağlayıcı için adres uydurma; taban adres
  `*_API_URL` ile ortamdan gelir. Adres yoksa sağlayıcı `NOT_CONFIGURED`'dır ve veri çekmez.
- **Lisans kapısı fail closed'dır.** `*_REDISTRIBUTION_ALLOWED` açıkça `"true"` değilse durum
  `LICENSE_REQUIRED`'dır. `enabled = true` yalnızca `LICENSED` iken mümkündür (DB kısıtı da zorlar).
  Bu mantığı gevşetme.
- **Sağlayıcı anahtarı yalnızca sunucuda.** `src/prices/providers/*` istemci bileşeninden import
  edilmez; anahtar API yanıtına, loga, denetim kaydına veya `price_providers` tablosuna yazılmaz.
- **Sağlayıcı hatasını ham yayma.** `TIMEOUT`, `NETWORK`, `HTTP_401`, `HTTP_5XX`, `BAD_PAYLOAD`
  gibi sabit güvenli kodlara indir; ham yanıt yalnızca hash olarak saklanır.
- Alış ve satış fiyatlarını birbirine çevirme, türetme veya yer değiştirme.
  `liquidationPrice` = piyasanın alışı (kullanıcının bozdurma karşılığı),
  `replacementPrice` = piyasanın satışı (kullanıcının yeniden alım maliyeti).
  Kullanıcının kendi işlem fiyatı bu ikisinden bağımsızdır ve maliyette esas olan odur.
- **Sessiz fallback EKLEME.** Bir sağlayıcı başarısız olduğunda başka sağlayıcıya, başka piyasaya
  veya başka şehrin fiyatına otomatik geçme. Fiyat yoksa "fiyat yok" gösterilir, sıfır gösterilmez.
- **Piyasaları karıştırma.** Bir portföyde tek aktif sağlayıcı/piyasa vardır; Kayseri fiyatıyla
  genel Türkiye fiyatı aynı hesapta birleştirilmez. `REFERENCE_ONLY` kaynak (BIST) değerlemede
  birincil kaynak olamaz.
- Test verisini gerçek piyasa verisi gibi etiketleme. `isRealMarketData: false` olan her kaynak
  arayüzde açıkça işaretlenir. Bayat veriye "güncel" deme.
- **Sağlayıcıyı bağlı olmadığı kurumun resmî servisi gibi anma.** "Harem resmî", "Altınkaynak
  resmî" gibi ifadeler yasaktır; AltinAPI bağımsız bir veri sağlayıcısıdır. Üst kaynağı bilinmeyen
  birleşik veri "Çoklu Kaynak" olarak etiketlenir.
- **Sembol eşlemesi değişirse `mappingVersion` artır** (`src/prices/providers/mappings.ts`);
  eski kayıtların hangi eşlemeyle üretildiği izlenebilir kalmalıdır.
- **Alım merkezîdir.** Tarayıcı sağlayıcıya bağlanmaz. Yeni sağlayıcı eklerken istek ömrü içinde
  kalıcı WebSocket açma; `price_ingestion_apply` yolunu (advisory lock + `run_key`) atlama.
- `PRICE_CRON_SECRET` tanımsızsa `/api/cron/price-ingestion` kapalıdır; bu davranışı değiştirme.
- **Zamanlanmış (makine) uçları `machineRoute` kullanır, `apiRoute` DEĞİL.** `apiRoute` tarayıcı
  CSRF çerezi ister; zamanlayıcıda çerez yoktur ve istek doğru secret'la bile reddedilir.
  Makine ucu oturum çözmez, çerez yazmaz. Normal mutation uçlarının CSRF'ini gevşetme.
- **Koşum anahtarını istemciden alma.** Sunucu dakikaya yuvarlayarak üretir; aynı dakikadaki
  tekrar çağrı ikinci kayıt oluşturmamalıdır.
- **Devre kesiciyi akışa bağlı tut.** `evaluateSnapshot` çağrısına `previousLiquidation`
  verilmezse `PRICE_JUMP` testte çalışır ama gerçek alımda ÇALIŞMAZ. Referans yalnızca aynı
  sağlayıcının aynı piyasadaki güncel kaydından alınır.
- **Karantina kaydı kalıcıdır.** Yalnızca sayı tutma; ürün, sebep, fiyat, zaman, eşleme sürümü
  ve koşum yazılır. Ham payload, adres ve anahtar SAKLANMAZ. Kayıtlar append-only'dir.
- **`providerTimestamp` eksikse `fetchedAt` yazma.** `timestampProvenance` "UNKNOWN" olur ve
  quote kalite kapısından geçemez. Bayat veriyi "az önce üretilmiş" gösterme.
- **Para birimini yanıttan doğrula.** Alan yoksa yalnızca sözleşme TL garantisi veriyorsa
  (`currencyFixedToTry`) TRY kabul edilir; aksi hâlde kayıt atlanır.
- **Taslak adapter üretim adapter'ı değildir.** `PrototypeJsonProvider` yalnızca hem
  `VERIFIED_CONTRACTS` içinde fixture'ı olan hem de `*_CONTRACT_VERSION` ile beyan edilen bir
  sürümle LICENSED olur. Yalnızca URL+anahtar girilmesi kaynağı AÇMAZ.
- **`capabilities` yalnızca çalışan yetenekleri listeler.** Sağlayıcının sunduğunu söylediği
  ama adapter'ı olmayanlar `advertisedCapabilities`'e yazılır. `requiresPersistentWorker`
  yalnızca aktif mod WebSocket ise true olur.
- **Global varsayılan kaynak AÇIKTIR.** "Listedeki ilk açık kaynak" davranışı ekleme; varsayılan
  yoksa kaynak atanmaz. Kullanıcının kendi tercihi global varsayılan değişince DEĞİŞMEZ.
- **Yönetici başka kullanıcının portföyünü HEDEFİN aktif kaynağıyla görür.** `getPriceProvider()`
  ile eski test sağlayıcısına dönme.
- **Sarraf Pro üretim eşlemesi boştur.** Yetkili sözleşme gelmeden tahmini sembol ekleme.
  Ekran gözlem eşlemesi ayrı dosyadadır ve üretim yolunda kullanılmaz.
- **Test sağlayıcısının üretim kapısı tek yerdedir** (`src/prices/dev-gate.ts`). Yeni bir
  `NODE_ENV === "production"` kontrolü yazma; `devOnlyProviderBlocked()` kullan. Kapı yalnızca
  var olan test kaçış kapısıyla (`AUTH_ALLOW_LOCAL_BACKEND`) açılır; başka bir bayrak ekleme.
- **Fiyat kaynağı okuyan/yazan her giriş noktası `ensureCatalog()` çağırır.** Katalog eşitlemesini
  yalnızca yönetim sayfasına veya cron'a bağlama; yeni kurulumda kullanıcı ekranı boş kalır.
- **Üretimde test verisine düşme.** `currentSnapshot()` aktif kaynak yoksa üretimde boş
  "unavailable" anlık görüntü döner; MARKET_BASELINE oluşturulmaz. Bu davranışı kolaylık
  gerekçesiyle geri alma.
- **Kalite kapısı fiyatı DEĞİŞTİRMEZ.** `evaluateQuote` yalnızca kabul/ret kararı verir ve
  quote'u olduğu gibi döndürür; eşik karşılaştırması için ürettiği `number` değerler asla
  saklanan fiyatın yerine yazılmaz. Yuvarlama veya normalizasyon ekleme.

## Yönetici ikinci faktörü (MFA)

- **`requireCurrentAdmin()` MFA kontrolünü içerir.** Bu kontrolü kaldırma, guard'ı MFA'sız bir
  varyantla değiştirme. `requireAdminForMfaSetup` YALNIZCA kurulum/doğrulama uçları içindir.
- TOTP secret'ı `AUTH_MFA_ENCRYPTION_KEY` ile AES-256-GCM şifreli saklanır; açık secret sütunu
  ekleme, secret'ı loga veya API yanıtına yazma (kurulum sırasında bir kez gösterilir).
- Kurtarma kodları yalnızca SHA-256 özetiyle saklanır ve tek kullanımlıktır.
- Kod karşılaştırmasını sabit zamanlı yap; deneme sayacını ve kilidi kaldırma.
- MFA sıfırlaması yalnızca başka bir yönetici tarafından, kullanıcı adı onayıyla yapılır ve
  hedefin oturumlarını kapatır. Parola değişimi MFA'yı sessizce kaldırmaz.
- `e2e/totp.ts` test tarafı bağımsız üreteçtir; `src/server/auth/totp.ts` "server-only" kalmalıdır.
  İkisinin eşliği `tests/price-sources.test.ts` §5'te doğrulanır.
- **Aynı TOTP kodu iki kez kabul edilmez.** `verifyTotp` eşleşen sayacı döndürür;
  `claimMfaCounter` sayacı ATOMİK olarak talep eder (tek koşullu UPDATE). Oku-sonra-yaz
  yapma: iki eşzamanlı istek aynı kodu geçirebilirdi.

## Deneysel araçlar

- `tools/experimental/` altındaki araçlar ÜRETİM YOLUNUN PARÇASI DEĞİLDİR. Sağlayıcı kaydına
  otomatik ekleme, kullanıcı portföyüne bağlama.
- Sarraf TV ekran toplayıcısı yalnızca `PRICE_EXPERIMENTAL_SARRAF_SCREEN=true` iken ve üretim
  dağıtımı DIŞINDA çalışır. Veri türü `LIVE_SCREEN_EXPERIMENTAL`'dir; "resmî API" denmez.
- **CAPTCHA/bot koruması aşılmaz.** Etkileşim istenirse sonuç BLOCKED'dır. Sayfanın yüklediği
  koruma altyapısı raporlanır ama delinmez.
- Artefaktlara cookie, authorization, token veya kişisel veri yazma; yazmadan önce
  `findForbiddenTraces` ile tara.
- Ekran yapısı beklenen imzaya uymazsa fail closed ol: yanlış fiyat üretmek yerine hiç üretme.

## Ekran gözlemi kaynağı ve worker (Sprint 3.2 — özel pilot)

- Ekran kaynağının kimliği AYRIDIR: `sarraf-tv-kayseri-screen`, lisans `EXPERIMENTAL_PRIVATE`,
  sağlayıcı türü `SCREEN`. Bunu lisanslı bir kaynakla aynı kimlik altında birleştirme,
  `REST` diye etiketleme, `REDISTRIBUTION_LICENSED` yeteneği verme.
- **Değerlemeye yalnızca `VALUATION_READY_CONFIDENCE` girer**
  (`NETWORK_VERIFIED`, `GROUPED_EXPLICIT`, `OPERATOR_VERIFIED`). `EXACT` tek başına ve
  `CONVENTION` yetmez. Bir ürünü "çalışsın diye" bu listeye ekleme; yönetici onayı yolu vardır.
- Ekran kaynağı `providerTimestamp: null` + `timestampProvenance: "OBSERVED"` üretir.
  Gözlem anını "kaynak fiyat zamanı" gibi sunma; arayüzde "Son ekran gözlemi" yazar.
  `UNKNOWN` köken her koşulda reddedilir.
- **Worker'a Supabase anahtarı verme.** `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  veya `service_role` worker ortamına, koduna veya imajına girmez. Worker yalnızca HMAC
  imzalı makine ucuna yazar; bu kural `tests/private-pilot.test.ts` tarafından denetlenir.
- Worker imzası iki dosyada birden uygulanır (`services/sarraf-screen-worker/src/signing.ts`
  ve `src/server/security/worker-signature.ts`). Birini değiştirirsen diğerini de değiştir;
  uyum testi kırılır.
- Worker'ın yazdığı fiyat **merkezî kalite kapısından** geçer. Kaynağa özel bir "hızlı yol"
  açma; `evaluateQuote` atlanamaz.
- **Kullanıcı bazlı izin listesi KALDIRILDI (0023).** Bir kaynağın kullanılabilir olup
  olmadığına yönetici `enabled` bayrağıyla TEK yerden karar verir. İkinci bir kapı katmanı
  yalnızca arıza üretiyordu: izinsiz kaynaktaki ürünler sessizce fiyatsız kalıyor, kullanıcı
  uygulamayı bozuk sanıyordu. Yeni bir "kullanıcı başına kaynak izni" katmanı EKLEME.
- **Lisans beyanı ortam ayarına bağlanamaz.** Lisanssız kaynak her ortamda lisanssız
  etiketlenir (`EXPERIMENTAL_PRIVATE`), `LICENSED` sayılmaz ve arayüzde "lisanslı veri
  değildir" notu kalır. Bu bir olgudur; kaldırılamaz, ortam bayrağıyla değiştirilemez.
- Fiyat alınamadığında kullanıcıyı **başka bir kaynağa sessizce düşürme**. Fiyat yoksa yok
  denir ve nedeni yazılır. Bu kural aynen geçerlidir.
- Kullanıcının AÇIKÇA seçtiği kaynak, hibrit plan tarafından ezilmez; plan yalnızca seçim
  yokken ya da seçilen kaynak zaten plandayken uygulanır.

## Ortam değişkeni okuma (ihlal edilemez)

- **`Number(process.env.X ?? "varsayilan")` YAZMA.** `??` boş string için
  devreye girmez; `PRICE_MAX_TRY=` gibi tanımlı-ama-boş bir değişken sessizce
  `0` üretir ve kalite kapısını çökertir. `tests/env-parsing.test.ts` bu kalıbın
  `src/` ve `services/` altına dönmesini engeller.
- Sayısal/metinsel ayarları `src/lib/env.ts` üzerinden oku: `numberFromEnv`,
  `stringFromEnv`, `flagFromEnv`. Boş ve yalnızca-boşluk değer "ayarlanmamış"
  sayılır; sınır dışı değer varsayılana düşer.
- Worker `@/` alias'ını kullanamaz; aynı kuralın kopyası
  `services/sarraf-screen-worker/src/policy.ts` içindedir. Birini değiştirirsen
  diğerini de değiştir — uyum testle denetlenir.

## Kaynak açma kapısı (ihlal edilemez)

Not: "özel pilot" ortam bayrağı kapısı KALDIRILDI. Kaynak üç ortam değişkenine
bağlıydı; biri eksik kalınca kaynak SESSİZCE ölüyor ve kullanıcı sebebini hiçbir
yerde göremiyordu. Üretimde tam olarak bu yaşandı. Yerine tek ve görünür bir
karar kondu: yöneticinin `enabled` bayrağı.

- **Kaynağı yalnızca yönetici açar/kapatır.** Ortam değişkeniyle kaynak açma veya
  kapatma mantığı EKLEME; sessiz kapanma üretir.
- Etkinleştirilebilir lisans durumları tek listede: `ACTIVATABLE_LICENSE_STATUS`
  (`price-source-service.ts`), `setPriceProviderFlags` ve veritabanı kısıtı
  `price_providers_enabled_requires_license` ile AYNI. Üçü birlikte değişir.
- **Lisanssız/yapılandırılmamış kaynak hâlâ etkinleştirilemez.** Kapı gevşetilmedi;
  yalnızca "deneysel" ayrımı kalktı.
- **`selectable` ile `canEnable` ayrı kavramlardır.** `selectable` = kullanıcı
  seçebilir mi; `canEnable` = sistem bu kaynaktan fiyat çekebilir mi. Arayüzde
  etkinleştirme düğmesini `selectable`e bağlama — deneysel kaynak arayüzden hiç
  açılamıyordu, sebebi buydu.
- Test verisi sağlayıcısının kapısı AYRIDIR ve üretim dağıtımında koşulsuz
  kapalıdır. Gerçek kaynağı açmak mock'u açmaz.

## E2E koşum bütünlüğü (ihlal edilemez)

- `playwright.config.ts` içinde `reuseExistingServer` **`false` kalır**. `true`
  olursa Playwright önceden çalışan sunucuyu devralır, `webServer.env` bloğunu
  HİÇ uygulamaz ve bütün takım yanlış yapılandırmayla sessizce koşar.
- `.env.example` içindeki **her** değişken `testEnv`'de açıkça sabitlenir.
  Next.js `.env.local` değerlerini yükler ama zaten ayarlı ortam değişkenlerini
  ezmez; sabitlenmeyen her değişken geliştiricinin yerel değerini alır.
- **Test komutunu `| tail` gibi bir boru hattından geçirme.** Bash boru hattının
  çıkış kodu son komutundur; `npx playwright test | tail` testler kırılsa bile
  `0` döner. Çıktıyı dosyaya yaz, `$?` yakala, `test-results/.last-run.json`
  dosyasına bak.

## Arayüz kuralları

- **Türkçe UI metinlerinde yazım hatası bırakma.** Türkçe karakterleri doğru kullan
  (ı/i, ş, ğ, ü, ö, ç). Ekleri doğru yaz.
- Fotoğraf ve kişiye özel logo kullanma. Ürün adı `src/config/app.config.ts` dosyasından gelir;
  başka yerde sabit yazılmaz.
- Mobil öncelikli çalış. **390 px genişlikte yatay kaydırma oluşmamalıdır**; geniş içerik kendi
  `overflow-x: auto` kabında kaydırılır.
- **Dar ekranda `shrink-0` düğme grubu kullanma.** `shrink-0` esnek öğeye max-content genişlik
  dayatır ve 390 px'te taşma üretir; grubu `w-full sm:w-auto` ile kendi satırına al.
- **Bölünmeyen uzun metinlere `break-words` ver** (ortam değişkeni adları, kodlar, URL'ler).
- **Piyasa kimliğini kullanıcıya HAM gösterme.** `marketLabel()` ile okunur ada çevir
  ("kayseri" → "Kayseri Yerel Piyasa"); eşleme harf durumuna duyarsızdır ve bilinmeyen değeri
  olduğu gibi bırakır (uydurma ad üretmez).
- **Paylaşılan bileşenlere `data-testid` eklerken bileşenin onu DOM'a geçirdiğini doğrula.**
  JSX'te `data-*` nitelikleri fazlalık özellik denetiminden muaftır; karşılanmayan prop sessizce
  düşer ve test kancası hiç oluşmaz (`Card` bu yüzden `data-testid`'yi açıkça karşılar).
- Erişilebilirlik: yeterli kontrast, klavye ile kullanılabilirlik, `aria-*` etiketleri,
  görünür odak halkası. Rengi tek bilgi taşıyıcı yapma.
- Ürün kataloğu yalnızca `src/domain/catalog.ts` içinde tanımlanır; bileşenlere dağıtılmaz.

## Test kuralları

- Yeni iş kuralı eklerken karşılık gelen testi de ekle.
- Güvenlik yüzeyi denetimleri `tests/security-surface.test.ts` içindedir; bu testleri zayıflatarak
  geçirme, kodu düzelt.
- Testleri atlamak (`skip`) veya beklentiyi gevşetmek yerine kök nedeni çöz.

---

@AGENTS.md
