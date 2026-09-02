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

Bu komut sırayla `lint`, `typecheck`, `test` ve `build` çalıştırır. Dördü de geçmeden işi
tamamlanmış sayma. Arayüzü etkileyen değişikliklerde ayrıca:

```bash
npm run test:e2e
```

## Güvenlik kuralları (ihlal edilemez)

- **Secret commit etme.** `.env.local`, gerçek anahtarlar, parolalar, tokenlar asla depoya girmez.
  Yalnızca `.env.example` commit edilir ve içinde gerçek değer bulunmaz.
- **`SUPABASE_SERVICE_ROLE_KEY` istemciye gönderilmez.** Bu anahtara yalnızca `src/server/` altındaki
  `import "server-only"` işaretli modüller erişebilir. `NEXT_PUBLIC_` öneki verilmesi yasaktır.
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
- **Denetim kaydına hassas veri yazma.** `admin_audit_logs` içine parola, parola özeti, tutar veya
  işlem detayı yazılmaz.
- Herkese açık kayıt ucu veya sayfası ekleme. E-posta OTP, sihirli bağlantı, telefon girişi,
  `signInWithOtp`, `resetPasswordForEmail` kullanma.

## Dağıtım ve cihaz kuralları

- **Yerel kurulum gerektiren hiçbir şey üretme:** EXE, MSI, BAT, PowerShell betiği, tarayıcı
  eklentisi, native helper, Electron/Tauri kabuğu. Uygulama normal HTTPS web uygulamasıdır.
- **PWA kurulumunu zorunlu kılma.** Hiçbir özellik `display-mode: standalone` kontrolüne veya
  servis çalışanına bağlı olamaz. `beforeinstallprompt` yalnızca bastırmak için kullanılır;
  `prompt()` çağrılmaz.
- **Parola veya oturum jetonunu JavaScript'ten okunabilir depoya yazma.** `localStorage`,
  `sessionStorage` ve `document.cookie` uygulama kodunda kullanılmaz. Oturum yalnızca
  `Secure` + `HttpOnly` + `SameSite=Lax` çerezle taşınır.
- **Ortak cihaz kısıtlarını zayıflatma:** kalıcı oturum yok, "beni hatırla" yok, servis çalışanı
  kaydı yok, cihaz izni istenmez, 15 dakika hareketsizlikte otomatik çıkış vardır.
  Hareketsizlik süresi üretimde sabittir; yalnızca geliştirme/test ortamında kısaltılabilir.
- **Servis çalışanına hassas yanıt yazma.** `/api/*` ve kimliği doğrulanmış sayfa yanıtları
  önbelleğe alınmaz.
- Kullanıcı portföyü bulut veritabanında saklanır; cihazlar arası senkronizasyon sunucu
  üzerinden yapılır.

## Fiyat verisi kuralları

- **Gerçek fiyat entegrasyonunu lisans/izin olmadan scrape ederek yapma.** KAYSARDER, Sarraf TV veya
  başka bir siteden izinsiz veri çekme.
- Alış ve satış fiyatlarını birbirine çevirme, türetme veya yer değiştirme.
  `buyPrice` = piyasanın alışı (kullanıcının bozdurma karşılığı),
  `sellPrice` = piyasanın satışı (kullanıcının yeniden alım maliyeti).
- Bir sağlayıcı başarısız olduğunda başka piyasanın fiyatına **sessizce geçme**. Fiyat yoksa
  arayüzde "fiyat yok" gösterilir, sıfır gösterilmez.
- Test verisini gerçek piyasa verisi gibi etiketleme. `isRealMarketData: false` olan her kaynak
  arayüzde açıkça işaretlenir.
- Bayat veriye "güncel" deme.

## Arayüz kuralları

- **Türkçe UI metinlerinde yazım hatası bırakma.** Türkçe karakterleri doğru kullan
  (ı/i, ş, ğ, ü, ö, ç). Ekleri doğru yaz.
- Fotoğraf ve kişiye özel logo kullanma. Ürün adı `src/config/app.config.ts` dosyasından gelir;
  başka yerde sabit yazılmaz.
- Mobil öncelikli çalış. **390 px genişlikte yatay kaydırma oluşmamalıdır**; geniş içerik kendi
  `overflow-x: auto` kabında kaydırılır.
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
