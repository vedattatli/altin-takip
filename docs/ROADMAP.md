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
  temiz DB'ye 0001→0007 uygulandı; 73 pgTAP testi ve gerçek JWT'li Data API
  sondası (21 beklenti) geçti. Uzak proje henüz yok.
- **Kalıcı oturum modeli (`0007_persistent_sessions.sql`):** cihaz türü seçimi ve
  15 dk hareketsizlik çıkışı kaldırıldı; 180 gün kaydırmalı ömür, ≤ 24 saatte bir
  yenileme, 7 günde bir sessiz kimlik yenileme (60 sn tolerans), "Tüm cihazlardan
  çıkış", yönetici oturum listesi/iptali, parola değişikliğinde bu cihazın korunması.
- 351+ birim/güvenlik testi; Playwright oturum senaryoları (`e2e/session.spec.ts`).

---

## Sprint 1 — Supabase ile gerçek ortam doğrulaması (önerilen sonraki adım)

Migration'lar, RPC'ler, tetikleyiciler, grant'lar ve RLS **yerel Supabase yığınında**
doğrulandı (0.6). Uzak (staging/production) proje henüz yok; ilk iş bu boşluğu
kapatmaktır.

1. Uzak Supabase projesi aç, `0001` → `0007` migration'larını sırayla uygula.
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

## Sprint 2 — Kalan güvenlik işleri

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
