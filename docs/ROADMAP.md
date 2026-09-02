# Yol Haritası

## Tamamlanan — Sprint 0 + 1 (bu tur)

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

---

## Sprint 2 — Supabase ile gerçek ortam doğrulaması (önerilen sonraki adım)

Bu turda Supabase projesi olmadığı için `SupabaseAuthBackend` yolu **yerel olarak
doğrulanamadı**. İlk iş bu boşluğu kapatmaktır.

1. Supabase projesi aç, `0001` → `0004` migration'larını uygula.
2. `npm run admin:create` ile gerçek yönetici hesabını oluştur.
3. Entegrasyon testleri: giriş, parola değişimi, yönetim işlemleri, RLS davranışı.
   Özellikle `is_admin()` ve `prevent_profile_privilege_escalation` politikalarını
   gerçek bir `authenticated` oturumla doğrula.
4. `app_sessions` için süresi geçmiş satırları temizleyen zamanlanmış görev (pg_cron).
5. Yerel geliştirme arka ucunu CI'da devre dışı bırakan bir kontrol ekle.

## Sprint 3 — Güvenlik sıkılaştırma

- Hız sınırlayıcıyı paylaşımlı depoya taşı (Redis veya Postgres) — çok örnekli dağıtım için.
- CSRF için çift gönderim çerezi (double submit cookie) ekle.
- Başarısız giriş denemeleri için ayrı bir güvenlik olay kaydı (audit'ten bağımsız).
- İçerik Güvenliği Politikası (CSP) ve güvenlik başlıkları (`next.config.ts` headers).
- Oturum listesi ekranı: kullanıcı kendi aktif oturumlarını görüp sonlandırabilsin.
- Yönetici için ikinci faktör (TOTP) — yalnızca yönetici hesapları için.

## Sprint 4 — Gerçek fiyat entegrasyonu

**Ön koşul: lisans veya yazılı izin.** İzinsiz scraping yapılmayacak.

- Lisanslı sağlayıcı sözleşmesi ve teknik dokümantasyon.
- `LicensedPriceProvider` uygulaması (`PriceProvider` sözleşmesine uyumlu).
- `current_prices` tablosunu besleyen sunucu tarafı yenileme görevi.
- Sağlayıcı hatasında **fallback yapılmadan** "fiyat alınamadı" durumunun uçtan uca doğrulanması.
- Fiyat kaynağı ve tazelik bilgisinin arayüzde sağlayıcı adıyla gösterilmesi.
- Birden fazla sağlayıcı desteklenirse: piyasa karıştırmayan, kullanıcı tarafından seçilebilir kaynak.

## Sprint 5 — Ürün derinleştirme

- Portföy geçmişi ve zaman içinde değer grafiği.
- Ürün bazlı detay ekranı ve işlem geçmişi filtreleri.
- CSV/Excel dışa aktarma (kullanıcının kendi verisi).
- Birden fazla portföy (örn. "Birikim", "Çeyrekler").
- Hedef takibi ("100 gram has altına ulaş").
- Yönetici için toplu kullanıcı oluşturma.

## Sprint 6 — Operasyon

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
