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
- Şirket/ortak cihaz modu: kalıcı olmayan oturum, 15 dk hareketsizlik çıkışı, servis çalışanı ve
  önbellek bırakılmaması, PWA kurulum çağrısının bastırılması.
- 201 birim/güvenlik testi + üç ekran genişliğinde Playwright duman testleri.

### Sprint 0.5 — güvenlik sertleştirme

- **Yetkilendirme sınırı:** markalanmış `UserActor` / `AdminActor` / `DataScope`
  tipleri; ham `userId` ile veri erişimi artık derleme hatası.
  `UserPortfolioService` ve `AdminService` ayrıldı.
- **Geçici parola guard'ı:** `requireUsableUser` ile sunucu tarafı koruma
  (`PASSWORD_CHANGE_REQUIRED`).
- **Sunucu tarafı oturum süresi:** ortak cihazda 15 dk hareketsizlik + 8 saat
  mutlak; kişisel cihazda mutlak süre zorunlu; `__Host-` önekli çerez.
- **CSRF:** Origin + Sec-Fetch-Site kontrolü ve imzalı senkronizasyon jetonu;
  tüm route'lar merkezi `apiRoute()` sarmalayıcısından geçer.
- **Güvenlik başlıkları:** CSP, HSTS (yalnızca üretim), Permissions-Policy,
  Referrer-Policy, X-Content-Type-Options, frame-ancestors.
- **Dağıtık hız sınırlayıcı:** Postgres tabanlı paylaşımlı sayaç, peppered HMAC
  anahtar, fail-closed davranış.
- **Veritabanı bütünlüğü:** tek portföy kısıtı, composite foreign key, birim
  tetikleyicisi, atomik aşırı satış koruması (`0005_security_hardening.sql`).
- **Denetim kaydı:** tetikleyici düzeyinde değiştirilemezlik; dürüst silme kaydı.
- **RLS davranış testleri:** `supabase/tests/rls.test.sql` (pgTAP, 24 test).
- **Temiz teslim paketi:** `npm run package:source` + SHA-256 + manifest.
- 284 birim/güvenlik testi + genişletilmiş Playwright güvenlik senaryoları.

---

## Sprint 1 — Supabase ile gerçek ortam doğrulaması (önerilen sonraki adım)

Supabase projesi olmadığı için `SupabaseAuthBackend`, atomik RPC'ler, veritabanı
tetikleyicileri ve RLS testleri **gerçek veritabanında doğrulanamadı**.
İlk iş bu boşluğu kapatmaktır.

1. Supabase projesi aç, `0001` → `0005` migration'larını sırayla uygula.
2. `npm run test:db` ile 24 pgTAP RLS testini çalıştır.
3. `npm run admin:create` ile gerçek yönetici hesabını oluştur.
4. Entegrasyon testleri: giriş, parola değişimi, yönetim işlemleri,
   `create_transaction_checked` ve eşzamanlı satış senaryosu.
5. `AUTH_CSRF_SECRET`, `RATE_LIMIT_PEPPER` ve `APP_ORIGIN` değerlerini üret ve ayarla.
6. `pg_cron` ile `purge_expired_sessions()` ve `login_rate_limit_cleanup()` görevlerini kur.
7. Yerel geliştirme arka ucunu CI'da devre dışı bırakan bir kontrol ekle.

## Sprint 2 — Kalan güvenlik işleri

- Nonce tabanlı CSP (satır içi script izni kaldırılsın).
- Başarısız giriş denemeleri için ayrı güvenlik olay kaydı (audit'ten bağımsız).
- Oturum listesi ekranı: kullanıcı kendi aktif oturumlarını görüp sonlandırabilsin.
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
| SMS OTP, push bildirim | Ortak cihaz gereksinimleriyle çelişir; ayrıca kapsam dışı |
| Mağaza paketi (iOS/Android), EXE/MSI | Uygulama hiçbir yerel kurulum gerektirmemelidir |
| Ödeme / abonelik | Bu ürün aşamasında gereksiz |
| Çoklu dil | Hedef kitle Türkçe; erken soyutlama maliyeti yüksek |
| Mikroservis mimarisi | Tek uygulama için gereksiz karmaşıklık |
| Adminin kullanıcı adına finansal kayıt düzenlemesi | Ayrı yetki olarak modellendi, varsayılan olarak kapalı |
