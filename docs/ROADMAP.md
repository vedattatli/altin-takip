# Yol Haritası

## Tamamlanan — Sprint 0 + 0.5

- Next.js 16 + TypeScript (strict) + Tailwind v4 tabanlı responsive web uygulaması ve PWA temeli.
- Merkezi ürün yapılandırması (`src/config/app.config.ts`) — ürün adı tek dosyadan değişir.
- 21 ürünlük merkezi altın kataloğu; ortalama maliyet, bozdurma/yeniden alım değerleme, kâr/zarar.
- `PriceProvider` soyutlaması ve `MockPriceProvider` (arayüzde "Test Verisi" olarak etiketli).
- `PortfolioRepository` soyutlaması: sunucu (hesap), IndexedDB (demo), bellek (test).
- Kullanıcı adı + parola girişi; herkese açık kayıt yok, kullanıcıları yalnızca yönetici açar.
- Kullanıcı adı → dahili Supabase kimliği eşlemesi (kullanıcıya hiç gösterilmez).
- Parola politikası, hız sınırı, artan bekleme, zorunlu ilk parola değişimi.
- Çalışan yönetim paneli: listeleme, arama, oluşturma, pasifleştirme/aktifleştirme,
  parola sıfırlama, onaylı kalıcı silme, kullanıcı portföyü görüntüleme.
- `admin_audit_logs` ile değiştirilemez denetim kaydı.
- Supabase şeması, RLS politikaları, yetki yükseltme tetikleyicisi, indeksler.
- Sunucu tarafında yönetilen, yalnızca HttpOnly çerezle taşınan oturum; tarayıcı deposuna
  hiçbir jeton yazılmaz. (Eski cihaz türü / 15 dk çıkış modeli 0.6'da kaldırıldı.)
- Üç ekran genişliğinde Playwright duman testleri.

### Sprint 0.5 — güvenlik sertleştirme

- **Yetkilendirme sınırı:** markalanmış `UserActor` / `AdminActor` / `DataScope`
  tipleri; ham `userId` ile veri erişimi artık derleme hatası.
  `UserPortfolioService` ve `AdminService` ayrıldı.
- **Geçici parola guard'ı:** `requireUsableUser` ile sunucu tarafı koruma
  (`PASSWORD_CHANGE_REQUIRED`).
- **Sunucu tarafı oturum süresi** ve `__Host-` önekli çerez (süre modeli 0.6'da
  kalıcı oturum lehine yeniden tasarlandı).
- **CSRF:** Origin + Sec-Fetch-Site kontrolü ve imzalı senkronizasyon jetonu;
  tüm route'lar merkezi `apiRoute()` sarmalayıcısından geçer.
- **Güvenlik başlıkları:** CSP, HSTS (yalnızca üretim), Permissions-Policy,
  Referrer-Policy, X-Content-Type-Options, frame-ancestors.
- **Dağıtık hız sınırlayıcı:** Postgres tabanlı paylaşımlı sayaç, peppered HMAC
  anahtar, fail-closed davranış.
- **Veritabanı bütünlüğü:** tek portföy kısıtı, composite foreign key, birim
  tetikleyicisi, atomik aşırı satış koruması (`0005_security_hardening.sql`).
- **Denetim kaydı:** tetikleyici düzeyinde değiştirilemezlik; dürüst silme kaydı.
- **RLS davranış testleri:** `supabase/tests/rls.test.sql` (pgTAP).
- **Temiz teslim paketi:** `npm run package:source` + SHA-256 + manifest.
- Genişletilmiş Playwright güvenlik senaryoları.

### Sprint 0.6 — veritabanı yetki sınırı, staging hazırlığı ve kalıcı oturum

- **`0006_database_boundary.sql`:** kritik SECURITY DEFINER RPC'ler yalnızca
  `service_role`; dahili yardımcılar hiçbir role açık değil; anon/authenticated
  için INSERT/UPDATE/DELETE grant'ı yok (Data API doğrudan yazma yüzeyi kapalı);
  0002 yazma politikaları kaldırıldı; varsayılan portföy provisioning
  tetikleyicisi + idempotent onarım (`npm run admin:repair`); `GET /api/portfolio`
  asla veri oluşturmaz; global + şema düzeyi varsayılan fonksiyon yetkileri kapatıldı.
- **Sıkı girdi doğrulama:** `side` yalnızca buy/sell, ürün katalogdan, NaN /
  Infinity / negatif / sıfır reddi.
- **Üretim sertleştirme:** `APP_ORIGIN` zorunlu (Host'tan türetme yok),
  `TRUSTED_PROXY_PROVIDER`, ham IP saklanmaz, üç sayaçlı giriş hız sınırı,
  `SUPABASE_SECRET_KEY` tercihli anahtar, saf Node ZIP paketleyici (`/` yollar,
  CRC + manifest doğrulaması), idempotent pg_cron bakım dosyası.
- **Gerçek veritabanı doğrulaması:** yerel Supabase yığını (CLI + Docker) ile
  temiz DB'ye 0001→0007 uygulandı; 73 pgTAP testi (Sprint 1 sonrası 0001→0010, 124 test) ve gerçek JWT'li Data API
  sondası (21 beklenti) geçti. Uzak proje henüz yok.
- **Kalıcı oturum modeli (`0007_persistent_sessions.sql`):** cihaz türü seçimi ve
  15 dk hareketsizlik çıkışı kaldırıldı; 180 gün kaydırmalı ömür, ≤ 24 saatte bir
  yenileme, 7 günde bir sessiz kimlik yenileme (60 sn tolerans), "Tüm cihazlardan
  çıkış", yönetici oturum listesi/iptali, parola değişikliğinde bu cihazın korunması.
- 351+ birim/güvenlik testi; Playwright oturum senaryoları (`e2e/session.spec.ts`).

---

### Sprint 1 — altın portföy muhasebe motoru

- **Oturum politikası:** "Bu cihazda oturumumu açık tut" kutusu; işaretliyse 180 gün
  kaydırmalı kalıcı oturum, işaretsizse tarayıcı oturumu çerezi + 8 saat / 30 dk; admin
  her zaman 8 saat / 15 dk (`0008_session_policy.sql`). Mevcut kullanıcı oturumları korundu.
- **Muhasebe modeli:** ürün bazlı hareketli ağırlıklı ortalama maliyet; append-only işlem
  defteri kaynak gerçek; `OPENING_BALANCE` (ACTUAL / ESTIMATED / MARKET_BASELINE), `BUY`
  (birim fiyat + masraf veya toplam ödenen), `SELL` (birim fiyat veya net tahsilat);
  VOID / REPLACE; idempotency; decimal.js + `numeric`; ondalık dize API
  (`0009_portfolio_accounting.sql`, `0010_accounting_rpc.sql`, `docs/ACCOUNTING_MODEL.md`).
- **Arayüz:** altı kart (bozdurma, yeniden alım, elde kalan maliyet, gerçekleşmemiş,
  gerçekleşmiş, toplam K/Z), Mevcut Altını Ekle / Yeni Alış / Satış akışları, maliyet
  kalite rozetleri, "Takip başlangıcından itibaren K/Z" etiketi, iptal/düzeltme kayıtlarının
  görünürlüğü.
- **Doğrulama:** 388 birim testi (kabul örnekleri + özellik testleri), 124 pgTAP, gerçek JWT
  sondası (31), `accounting:verify`, `accounting:smoke`, Playwright.

### Sprint 1.1 — muhasebe bütünlüğü ve veri semantiği

- **Veritabanı sınırı:** `service_role` `transactions` / `price_snapshots` tablolarına doğrudan
  yazamaz; finansal mutation yalnızca SECURITY DEFINER RPC'lerle (`0011_accounting_integrity.sql`).
- **Köken ayrımı:** elde kalan pozisyon kökeni (miktar sıfıra inince sıfırlanır) ile gerçekleşmiş
  K/Z'nin tarihsel kökeni ayrı bayraklarda.
- **Girilen fiyat ≠ efektif maliyet:** `quoted_*` sütunları ile türetilmiş `effective_*` sütunları;
  TOTAL_AMOUNT'ta girilen fiyat uydurulmaz.
- **Zaman:** sıkı takvim doğrulaması, isteğe bağlı saat, `occurred_at timestamptz` sırası
  (Europe/Istanbul).
- **Savunma:** anlık görüntü doğrulaması (makas/zaman/para birimi/ürün), kısmi değerleme etiketi,
  iç boşluk ve belirsiz ayırıcıyı reddeden sayı ayrıştırıcı.
- **Doğrulama:** 416 birim testi, 156 pgTAP, gerçek JWT sondası (38), `accounting:verify`,
  `accounting:smoke`, Playwright.

### Sprint 2 — uzak staging, telefon–PC senkronizasyonu, son doğruluk düzeltmeleri

- **Fiyat doğrulaması merkezîleşti** (`validateUsableQuote`); `valuationStatus` ve
  `portfolioState` ile "hiç fiyat yok" ve "tamamen satılmış" durumları ayrıldı.
- **Idempotency eşitliği:** demo depoları sunucuyla aynı parmak izi semantiğini uygular; replace
  replay biçimi eşitlendi.
- **Sayısal sınırlar:** 12 tam basamak; birikimli pozisyon dâhil; sıkı ayrıştırma (P0004 → 400).
- **Cascade kanıtı:** gerçek auth silme ucu ile 7 tablo sıfır (sonda + pgTAP).
- **Senkronizasyon:** `portfolios.ledger_revision` + `GET /api/portfolio/version` + revision
  polling (≤ 15 sn), `0012_staging_sync.sql`.
- **Staging araçları:** doctor / migrate / smoke / seed / admin / cleanup / test:staging
  (docs/STAGING.md). Dış hesaplar kullanıcı girişine bağlıdır.
- **Doğrulama:** 437 birim testi, 184 pgTAP, gerçek JWT sondası (46), Playwright (255 geçti, 3 atlandı).
- **BEKLEMEDE (dış hesap girişi gerekiyor):** uzak Supabase staging projesi, Vercel staging
  dağıtımı, gerçek staging E2E (`npm run test:staging`) ve GitHub private repo push'u
  YAPILMADI. Kod, migration'lar ve araçlar hazır; yalnızca kullanıcı girişi bekleniyor.
  Devam listesi: [STAGING.md → "Beklemede"](STAGING.md#5-beklemede-dış-hesap-girişi-gerektiren-adımlar).

## Sprint 3 — Supabase ile gerçek ortam doğrulaması (önerilen sonraki adım)

Migration'lar, RPC'ler, tetikleyiciler, grant'lar ve RLS **yerel Supabase yığınında**
doğrulandı (0.6). Uzak (staging/production) proje henüz yok; ilk iş bu boşluğu
kapatmaktır.

1. Uzak Supabase projesi aç, `0001` → `0012` migration'larını sırayla uygula (`npm run staging:migrate`).
2. Aynı projeye karşı `npm run test:db` mantığını (pgTAP) ve `npm run test:data-api`
   sondasını çalıştır (sonda için proje URL / anahtar / JWT secret ortam değişkenleri).
3. `npm run admin:create` ile gerçek yönetici hesabını oluştur; gerekirse `npm run admin:repair`.
4. Entegrasyon testleri: giriş, kalıcı oturum yenileme/rotation, parola değişimi,
   yönetim işlemleri, `create_transaction_checked` ve eşzamanlı satış senaryosu.
5. `AUTH_CSRF_SECRET`, `RATE_LIMIT_PEPPER`, `APP_ORIGIN`, `TRUSTED_PROXY_PROVIDER` ve
   `SUPABASE_SECRET_KEY` değerlerini üret ve ayarla.
6. `supabase/setup/maintenance-cron.sql` ile pg_cron görevlerini kur ve
   `cron.job_run_details` ile çalıştığını doğrula.
7. Yerel geliştirme arka ucunu CI'da devre dışı bırakan bir kontrol ekle.

## Sprint 2b — Kalan güvenlik işleri

- Nonce tabanlı CSP (satır içi script izni kaldırılsın).
- Başarısız giriş denemeleri için ayrı güvenlik olay kaydı (audit'ten bağımsız).
- Kullanıcı için oturum listesi ekranı (cihaz etiketi/tarih) — yönetici tarafı ve
  "tüm cihazlardan çıkış" 0.6'da tamamlandı; `AuthService.listOwnSessions` hazır.
- Yönetici için ikinci faktör (TOTP).
- Denetim kaydı için dışa aktarma ve saklama politikası.

## Sprint 3 — Gerçek fiyat entegrasyonu

**Ön koşul: lisans veya yazılı izin.** İzinsiz scraping yapılmayacak.

- Lisanslı sağlayıcı sözleşmesi ve teknik dokümantasyon.
- `LicensedPriceProvider` uygulaması (`PriceProvider` sözleşmesine uyumlu).
- `current_prices` tablosunu besleyen sunucu tarafı yenileme görevi.
- Sağlayıcı hatasında **fallback yapılmadan** "fiyat alınamadı" durumunun uçtan uca doğrulanması.
- Fiyat kaynağı ve tazelik bilgisinin arayüzde sağlayıcı adıyla gösterilmesi.
- Birden fazla sağlayıcı desteklenirse: piyasa karıştırmayan, kullanıcı tarafından seçilebilir kaynak.

## Sprint 4 — Ürün derinleştirme

- Portföy geçmişi ve zaman içinde değer grafiği.
- Ürün bazlı detay ekranı ve işlem geçmişi filtreleri.
- CSV/Excel dışa aktarma (kullanıcının kendi verisi).
- Birden fazla portföy (örn. "Birikim", "Çeyrekler").
- Muhasebe genişletmeleri: `TRANSFER_IN` / `TRANSFER_OUT` / `ADJUSTMENT` işlem türleri
  (tasarım hazır, bu sprintte eklenmedi). FIFO/XIRR/TWR/vergi muhasebesi bilinçli olarak yok.
- Hedef takibi ("100 gram has altına ulaş").
- Yönetici için toplu kullanıcı oluşturma.

## Sprint 5 — Operasyon

- Production deployment ve alan adı (bu turda kapsam dışıydı).
- İzleme, hata takibi ve yedekleme politikası.
- Veri saklama ve silme politikası (KVKK uyumu).
- Kullanıcı için hesap verisi dışa aktarma ve silme talebi akışı.

---

## Bilinçli olarak kapsam dışı bırakılanlar

| Konu | Neden |
| --- | --- |
| İzinsiz fiyat scraping (KAYSARDER, Sarraf TV vb.) | Lisans/izin olmadan yapılmaz |
| SMS OTP, push bildirim | Kapsam dışı; cihaz izni istenmez |
| Mağaza paketi (iOS/Android), EXE/MSI | Uygulama hiçbir yerel kurulum gerektirmemelidir |
| Ödeme / abonelik | Bu ürün aşamasında gereksiz |
| Çoklu dil | Hedef kitle Türkçe; erken soyutlama maliyeti yüksek |
| Mikroservis mimarisi | Tek uygulama için gereksiz karmaşıklık |
| Adminin kullanıcı adına finansal kayıt düzenlemesi | Ayrı yetki olarak modellendi, varsayılan olarak kapalı |
