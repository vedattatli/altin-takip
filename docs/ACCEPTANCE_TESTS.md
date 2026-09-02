# Kabul Kriterleri ve Testler

Çalıştırma:

```bash
npm run verify
```

`lint` → `typecheck` → `test` (Vitest) → `build` → `verify:bundle` sırasıyla çalışır.
Tarayıcı testleri ayrıca:

```bash
npm run test:e2e
```

Playwright üç ekran genişliğinde koşar: **390×844**, **768×1024**, **1440×900**.

Tarayıcı testleri **üretim derlemesine** karşı çalışır (`next build` + `next start`), böylece
kullanıcıya gidecek kodun tam olarak aynısı doğrulanır. Supabase olmadan çalışabilmek için yerel
kimlik doğrulama arka ucu açık bir test kaçış kapısıyla etkinleştirilir
(`AUTH_ALLOW_LOCAL_BACKEND=yalnizca-test-icin`); bu değişken üretim dağıtımlarında ayarlanmaz.
Ayrıntı: [SECURITY.md](SECURITY.md) bölüm 2.1.

---

## 1. Portföy ve hesaplama

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 1.1 | Yeni hesap tamamen boş portföyle açılır | `tests/portfolio.test.ts` → "yeni hesap tamamen sıfır değerlerle açılır"<br>`e2e/portfolio.spec.ts` → "yeni hesap tamamen boş açılır" |
| 1.2 | Örnek/varsayılan varlık (örn. 104 gram) eklenmez | `tests/portfolio.test.ts` → "varsayılan örnek varlık (örn. 104 gram) eklenmez" |
| 1.3 | Altın eklenince toplamlar doğru hesaplanır | `tests/portfolio.test.ts` → "alış işlemleri" bloğu<br>`e2e/portfolio.spec.ts` → "altın eklenince toplamlar doğru hesaplanır ve yenilemede korunur" |
| 1.4 | Sayfa yenilenince veriler korunur | `tests/storage.test.ts` → "sayfa yenilense de veriler korunur"<br>`e2e/portfolio.spec.ts` (aynı test, `page.reload()`) |
| 1.5 | Kayıt silinince toplamlar güncellenir | `tests/portfolio.test.ts` → "kayıt silme" bloğu<br>`e2e/portfolio.spec.ts` → "kayıt silinince toplamlar sıfırlanır" |
| 1.6 | Kayıt düzenlenebilir | `tests/storage.test.ts` → "kaydı günceller"<br>`e2e/portfolio.spec.ts` → "işlem düzenlenebilir" |
| 1.7 | Ortalama maliyet ve gerçekleşmiş kâr/zarar doğru | `tests/portfolio.test.ts` → "satış işlemleri" bloğu |
| 1.8 | Has altın karşılığı milyeme göre hesaplanır | `tests/portfolio.test.ts` → "has altın karşılığını ürünün milyemine göre hesaplar" |

## 2. Fiyat verisi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 2.1 | Alış ve satış fiyatları ters kullanılmaz | `tests/portfolio.test.ts` → "bozdurma değeri ALIŞ, yeniden alım değeri SATIŞ fiyatıyla hesaplanır" |
| 2.2 | Her üründe `buyPrice < sellPrice` | `tests/prices.test.ts` → "her ürün için alış fiyatı satış fiyatından düşüktür" |
| 2.3 | Alış/satış birbirinden türetilmez | `tests/prices.test.ts` → "alış ve satış birbirinden türetilmez; makas kategoriye göre değişir" |
| 2.4 | Mock fiyatlar gerçek fiyat gibi etiketlenmez (kompakt şeritte de) | `tests/prices.test.ts` → "mock fiyatları gerçek piyasa verisi gibi etiketlemez"<br>`e2e/portfolio.spec.ts` → "fiyat kaynağı test verisi olarak etiketlenir" |
| 2.5 | Sağlayıcı hatasında başka piyasaya sessiz geçiş yapılmaz | `tests/prices.test.ts` → "sağlayıcı çalışmadığında başka piyasaya sessizce geçmez" |
| 2.6 | Fiyatı olmayan pozisyon sıfır gösterilmez | `tests/portfolio.test.ts` → "fiyat kaydı yoksa değer 0 gösterilmez, null kalır" |
| 2.7 | Bayat veri "güncel" sayılmaz | `tests/prices.test.ts` → "tazelik süresi geçen anlık görüntü güncel sayılmaz" |
| 2.8 | Fiyat kaydı gerekli tüm alanları içerir | `tests/prices.test.ts` → "her fiyat kaydı gerekli tüm alanları içerir" |
| 2.9 | Veritabanı ters fiyat kaydını reddeder | `supabase/migrations/0001_init.sql` → `current_prices_spread_check` |

## 3. Doğrulama

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 3.1 | Negatif veya sıfır miktar kabul edilmez | `tests/validation.test.ts`<br>`e2e/portfolio.spec.ts` → "geçersiz miktar kabul edilmez" |
| 3.2 | Satış miktarı eldeki miktarı aşamaz | `tests/validation.test.ts` → "satış miktarı sınırı" bloğu<br>`e2e/portfolio.spec.ts` → "satış miktarı eldeki miktarı aşamaz" |
| 3.3 | Adet ürünlerde ondalık miktar reddedilir | `tests/validation.test.ts`<br>`e2e/portfolio.spec.ts` → "adet ile takip edilen üründe ondalık miktar reddedilir" |
| 3.4 | Gelecek tarihli işlem reddedilir | `tests/validation.test.ts` → "gelecek tarihli işlemi reddeder" |
| 3.5 | Negatif işçilik reddedilir | `tests/validation.test.ts` → "negatif işçilik tutarını reddeder" |
| 3.6 | Sunucu istemci doğrulamasına güvenmez | `src/server/transactions.ts` (yeniden doğrulama) |

## 4. Ürün kataloğu

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 4.1 | Gereksinim listesindeki 21 ürün eksiksiz | `tests/catalog.test.ts` → "gereksinim listesindeki tüm ürünleri içerir" |
| 4.2 | Katalog tek kaynaktan yönetilir, SQL kopyası senkron | `tests/catalog.test.ts` → "SQL referans dosyası katalogla aynı ürünleri içerir" |

## 5. Kimlik doğrulama

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 5.1 | Herkese açık kayıt endpoint'i yok | `tests/security-surface.test.ts` → "kayıt / signup uç noktası bulunmaz" |
| 5.2 | Kayıt sayfası ve bağlantısı yok | `tests/security-surface.test.ts` → "kayıt sayfası bulunmaz", "giriş ekranında kayıt bağlantısı yoktur" |
| 5.3 | E-posta OTP / sihirli bağlantı arayüzü yok | `tests/security-surface.test.ts` → "Supabase OTP / magic link çağrıları kullanılmaz"<br>`e2e/auth.spec.ts` → "yalnızca kullanıcı adı ve parola sorar" |
| 5.4 | Login formu kullanıcı adı ve parola kabul eder | `e2e/auth.spec.ts` → "yalnızca kullanıcı adı ve parola sorar" |
| 5.5 | Kullanıcı adı normalize edilir | `tests/username.test.ts` → "kullanıcı adı normalizasyonu" bloğu |
| 5.6 | Aynı adın farklı harf varyasyonları oluşturulamaz | `tests/auth-service.test.ts` → "aynı kullanıcı adının farklı harf varyasyonu oluşturulamaz"<br>`e2e/admin.spec.ts` → "aynı kullanıcı adı farklı harflerle oluşturulamaz" |
| 5.7 | Hata mesajı kullanıcı/parola ayrımı yapmaz | `tests/auth-service.test.ts` → "olmayan kullanıcı ile yanlış parola AYNI mesajı verir"<br>`e2e/auth.spec.ts` → "hatalı girişte ayrım yapmayan genel mesaj gösterir" |
| 5.8 | Pasif kullanıcı giriş yapamaz | `tests/auth-service.test.ts` → "pasif kullanıcı giriş yapamaz…"<br>`e2e/admin.spec.ts` → "yönetici kullanıcıyı pasifleştirir; pasif kullanıcı giriş yapamaz" |
| 5.9 | Giriş denemelerine hız sınırı uygulanır | `tests/password-and-rate-limit.test.ts` → "giriş hız sınırlayıcı" bloğu<br>`tests/auth-service.test.ts` → "tekrarlanan başarısız denemede geçici bekleme uygular" |
| 5.10 | Çıkış yapılabilir | `e2e/auth.spec.ts` → "çıkış yapınca oturum kapanır" |
| 5.11 | Kimlik bilgileri adres çubuğuna yazılmaz | Giriş formu `method="post"` + hidrasyon tamamlanana kadar düğme kilitli |

## 6. Parola yönetimi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 6.1 | En az 10 karakter | `tests/password-and-rate-limit.test.ts` → "10 karakterden kısa parolayı reddeder" |
| 6.2 | Zayıf ve yaygın parolalar engellenir | aynı dosya → "yaygın parolaları reddeder", "ardışık karakter dizisi…" |
| 6.3 | İlk girişte parola değiştirmeye yönlendirilir | `e2e/auth.spec.ts` → "geçici parolalı kullanıcı parola değiştirme ekranına yönlendirilir" |
| 6.4 | Kullanıcı mevcut parolasını doğrulayarak değiştirir | `tests/auth-service.test.ts` → "kendi parolasını değiştirme" bloğu |
| 6.5 | Değişiklik sonrası diğer oturumlar düşer | `tests/auth-service.test.ts` → "değişiklik sonrası diğer cihazlardaki oturumlar düşer" |
| 6.6 | Yönetici mevcut parolayı göremez | `tests/auth-service.test.ts` → "yönetici mevcut parolayı hiçbir uçtan göremez" |
| 6.7 | Parola sıfırlama tüm oturumları geçersiz kılar | `tests/auth-service.test.ts` → "sıfırlama tüm aktif oturumları geçersiz kılar" |

## 7. Yetkilendirme

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 7.1 | Normal kullanıcı başka kullanıcının portföyünü okuyamaz | `tests/auth-service.test.ts` → "normal kullanıcı başka kullanıcının portföyünü okuyamaz", "kullanıcı verileri hesap bazında ayrışır"<br>`e2e/portfolio.spec.ts` → "kullanıcılar birbirinin portföyünü görmez" |
| 7.2 | Normal kullanıcı admin endpoint'lerine erişemez | `tests/auth-service.test.ts` → "yönetici: yetkilendirme" bloğu<br>`e2e/admin.spec.ts` → "normal kullanıcı yönetim API uçlarına erişemez" |
| 7.3 | Normal kullanıcı kendisini admin yapamaz | `tests/auth-service.test.ts` → "oluşturulan hesap YÖNETİCİ olamaz…"<br>`e2e/admin.spec.ts` → "kullanıcı kendisini yönetici yapamaz"<br>SQL: `prevent_profile_privilege_escalation` |
| 7.4 | Normal kullanıcı kullanıcı listesine erişemez | `tests/auth-service.test.ts` → "normal kullanıcı kullanıcı listesine erişemez" |
| 7.5 | Oturumsuz istek reddedilir | `e2e/admin.spec.ts` → "oturumsuz istek yönetim uçlarına erişemez" |
| 7.6 | UI'da menü gizlemek tek önlem değildir | `tests/security-surface.test.ts` → "her yönetim ucu requireCurrentAdmin çağırır" |

## 8. Yönetim paneli

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 8.1 | Yönetici kullanıcı oluşturabilir | `tests/auth-service.test.ts` → "yeni kullanıcı oluşturur…"<br>`e2e/admin.spec.ts` → "yönetici yeni kullanıcı oluşturur…" |
| 8.2 | Kullanıcı arama çalışır | `e2e/admin.spec.ts` → "yönetici kullanıcı arar" |
| 8.3 | Yönetici pasifleştirebilir / aktifleştirebilir | `e2e/admin.spec.ts` → ilgili iki test |
| 8.4 | Yönetici parola sıfırlayabilir | `e2e/admin.spec.ts` → "yönetici parola sıfırlar; eski parola geçersiz olur" |
| 8.5 | Yönetici portföyü görüntüler, düzenleyemez | `tests/auth-service.test.ts` → "ilk sürümde yönetici kullanıcı adına düzenleme yapamaz"<br>`e2e/admin.spec.ts` → "yönetici kullanıcının portföyünü görüntüler ama düzenleyemez" |
| 8.6 | Kalıcı silme açık onay olmadan çalışmaz | `tests/auth-service.test.ts` → "onay yazılmadan kalıcı silme çalışmaz"<br>`e2e/admin.spec.ts` → "kalıcı silme açık onay olmadan çalışmaz" |
| 8.7 | Son yönetici ve kendi hesabı korunur | `tests/auth-service.test.ts` → "yönetici: pasifleştirme ve silme" bloğu |

## 9. Denetim kaydı

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 9.1 | Tüm yönetici işlemleri kaydedilir | `tests/auth-service.test.ts` → "denetim kaydı (audit log)" bloğu |
| 9.2 | Başarısız silme girişimi kaydedilir | aynı blok → "başarısız silme girişimini de kaydeder" |
| 9.3 | Kayda parola veya finansal içerik yazılmaz | aynı blok → "denetim kaydına parola veya finansal içerik yazılmaz" |
| 9.4 | Yönetici işlemleri gerçekten kayıt üretir (uçtan uca) | `e2e/admin.spec.ts` → "yönetici işlemleri denetim kaydı oluşturur" |

## 10. Şirket cihazı ve dağıtım

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 10.1 | Hiçbir EXE/MSI/BAT/eklenti/native yardımcı yok | `tests/deployment-surface.test.ts` → "yerel kurulum gerektiren bileşen yoktur" |
| 10.2 | PWA kurulumu isteğe bağlı; hiçbir özellik ona bağlı değil | `tests/deployment-surface.test.ts` → "PWA kurulumu isteğe bağlıdır"<br>`e2e/device.spec.ts` → "kurulu PWA olmadan tüm ekranlar çalışır" |
| 10.3 | Giriş ekranında cihaz türü seçimi var, "beni hatırla" yok | `tests/deployment-surface.test.ts` → "giriş ekranı cihaz seçimi"<br>`e2e/device.spec.ts` → "giriş ekranı kişisel ve ortak cihaz seçeneği sunar" |
| 10.4 | Ortak cihazda oturum kalıcı değildir | `tests/device-mode.test.ts` → "ortak cihazda KALICI DEĞİLDİR"<br>`e2e/device.spec.ts` → "ortak cihazda oturum çerezi kalıcı değildir" |
| 10.5 | Ortak cihazda 15 dk hareketsizlikte otomatik çıkış | `tests/device-mode.test.ts` → "ortak cihaz için 15 dakikadır"<br>`e2e/device.spec.ts` → "ortak cihazda hareketsizlik sonrası otomatik çıkış yapılır" |
| 10.6 | Ortak cihazda SW kaydı ve önbellek bırakılmaz | `e2e/device.spec.ts` → "ortak cihazda servis çalışanı kaydedilmez ve önbellek bırakılmaz" |
| 10.7 | Token/portföy JS'ten okunabilir depoya yazılmaz | `tests/deployment-surface.test.ts` → "kimlik bilgisi ve portföy verisi tarayıcı deposuna yazılmaz"<br>`e2e/device.spec.ts` → "oturum jetonu JavaScript'ten okunamaz" |
| 10.8 | Hassas API yanıtları SW önbelleğine alınmaz | `tests/deployment-surface.test.ts` → "servis çalışanı hassas yanıtları önbelleğe almaz" |
| 10.9 | Cihaz izni (bildirim/push/konum) istenmez | `tests/deployment-surface.test.ts` → "cihaz izinleri istenmez" |
| 10.10 | Portföy bulutta saklanır, sunucu üzerinden senkronize olur | `tests/deployment-surface.test.ts` → "oturum açmış kullanıcının verisi sunucu deposunda tutulur" |

## 11. Gizlilik ve secret yönetimi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 11.1 | `service_role` anahtarı istemci kodunda yok | `tests/security-surface.test.ts` → "service_role anahtarı istemciye sızmaz" |
| 11.2 | `service_role` anahtarı derlenmiş istemci paketinde yok | `npm run verify:bundle` → `scripts/check-client-bundle.mjs` |
| 11.3 | Uygulama tablolarında parola sütunu yok | `tests/security-surface.test.ts` → "SQL şemasında parola sütunu yoktur" |
| 11.4 | RLS tüm kullanıcı tablolarında açık | `tests/security-surface.test.ts` → "RLS politikaları tanımlıdır" bloğu |

## 12. Arayüz kalitesi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 12.1 | 390 px'te yatay taşma yok (giriş, panel, işlemler, ayarlar) | `e2e/auth.spec.ts`, `e2e/portfolio.spec.ts` → "tüm ekranlarda yatay taşma yoktur" |
| 12.2 | 390 px'te yönetim ekranları taşmaz | `e2e/admin.spec.ts` → "yönetici kullanıcı listesini görür", "…portföyünü görüntüler…" |
| 12.3 | 768 ve 1440 px'te aynı testler geçer | Playwright `tablet-768` ve `masaustu-1440` projeleri |
| 12.4 | Uygulama derlenir, TypeScript ve lint hatası kalmaz | `npm run verify` |

Ekran görüntüleri: `docs/screenshots/mobile.png` ve `docs/screenshots/desktop.png`
(`e2e/screenshots.spec.ts` tarafından üretilir).
