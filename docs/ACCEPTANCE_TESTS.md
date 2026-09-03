# Kabul Kriterleri ve Testler

Çalıştırma:

```bash
npm run verify
```

`lint` → `typecheck` → `test` (Vitest) → `build` → `verify:bundle` sırasıyla çalışır.

Ek komutlar:

```bash
npm run test:db
```

(Supabase CLI + Docker; temiz veritabanına 0001→0012 uygular, 184 pgTAP testi koşar.)

```bash
npm run accounting:verify
```

(Defteri yeniden oynatır, türetilmiş pozisyonlarla karşılaştırır; tutarsızlıkta başarısız.)

```bash
npm run accounting:smoke
```

(Yalnızca yerel Supabase: gerçek RPC yolundan kabul örnekleri.)

```bash
npm run test:data-api
```

(Yerel Supabase'e karşı gerçek anon / authenticated JWT ile Data API sondası.)

```bash
npm run package:source
```

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
| 2.2 | Her üründe `liquidationPrice < replacementPrice` (bozdurma < yeniden alım) | `tests/prices.test.ts` → "her ürün için alış fiyatı satış fiyatından düşüktür" |
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
| 10.2 | PWA kurulumu isteğe bağlı; hiçbir özellik ona bağlı değil | `tests/deployment-surface.test.ts` → "PWA kurulumu isteğe bağlıdır"<br>`e2e/session.spec.ts` → "kurulu PWA olmadan tüm ekranlar çalışır" |
| 10.3 | Giriş ekranı cihaz türü SORMAZ; tek tercih "oturumumu açık tut" (varsayılan işaretsiz) | `tests/deployment-surface.test.ts` → "cihaz türü seçimi SUNMAZ"<br>`e2e/session.spec.ts` → "cihaz türü sormaz; yalnızca 'oturumumu açık tut' kutusu vardır" |
| 10.4 | Oturum çerezi kalıcı, HttpOnly, SameSite=Lax | `tests/session-cookie.test.ts`<br>`e2e/session.spec.ts` → "çerez kalıcı, HttpOnly ve SameSite=Lax'tır" |
| 10.5 | İstemcide hareketsizlik sayacı / otomatik çıkış yok | `tests/deployment-surface.test.ts` → "istemcide hareketsizlik sayacı veya otomatik çıkış yoktur" |
| 10.6 | Servis çalışanı yalnızca üretimde; cihaz türüne bakmaz | `tests/deployment-surface.test.ts` → "servis çalışanı yalnızca üretim derlemesinde kaydedilir" |
| 10.7 | Token/portföy JS'ten okunabilir depoya yazılmaz | `tests/deployment-surface.test.ts` → "kimlik bilgisi ve portföy verisi tarayıcı deposuna yazılmaz"<br>`e2e/session.spec.ts` → "oturum kimliği JavaScript'ten okunamaz ve tarayıcı deposunda yoktur" |
| 10.8 | Hassas API yanıtları SW önbelleğine alınmaz | `tests/deployment-surface.test.ts` → "servis çalışanı hassas yanıtları önbelleğe almaz" |
| 10.9 | Cihaz izni (bildirim/push/konum) istenmez | `tests/deployment-surface.test.ts` → "cihaz izinleri istenmez" |
| 10.10 | Portföy bulutta saklanır, sunucu üzerinden senkronize olur | `tests/deployment-surface.test.ts` → "oturum açmış kullanıcının verisi sunucu deposunda tutulur" |

## 11. Gizlilik ve secret yönetimi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 11.1 | Sunucu anahtarı istemci kodunda yok | `tests/security-surface.test.ts` → "service_role anahtarı istemciye sızmaz" |
| 11.2 | `SUPABASE_SECRET_KEY` / `service_role` / `sb_secret_` derlenmiş istemci paketinde yok | `npm run verify:bundle` → `scripts/check-client-bundle.mjs`; `tests/database-boundary.test.ts` → "istemci paketi taraması" |
| 11.3 | Uygulama tablolarında parola sütunu yok | `tests/security-surface.test.ts` → "SQL şemasında parola sütunu yoktur" |
| 11.4 | RLS tüm kullanıcı tablolarında açık | `tests/security-surface.test.ts` → "RLS politikaları tanımlıdır" bloğu |

## 12. Arayüz kalitesi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 12.1 | 390 px'te yatay taşma yok (giriş, panel, işlemler, ayarlar) | `e2e/auth.spec.ts`, `e2e/portfolio.spec.ts` → "tüm ekranlarda yatay taşma yoktur" |
| 12.2 | 390 px'te yönetim ekranları taşmaz | `e2e/admin.spec.ts` → "yönetici kullanıcı listesini görür", "…portföyünü görüntüler…" |
| 12.3 | 768 ve 1440 px'te aynı testler geçer | Playwright `tablet-768` ve `masaustu-1440` projeleri |
| 12.4 | Uygulama derlenir, TypeScript ve lint hatası kalmaz | `npm run verify` |

## 13. Yetkilendirme sınırı (Sprint 0.5)

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 13.1 | Her API ucu beklenen guard'ı kullanır | `tests/authorization-matrix.test.ts` → "her route beklenen guard'ı kullanır" |
| 13.2 | Her route merkezi `apiRoute()` sarmalayıcısından geçer | aynı dosya → "her route merkezi apiRoute sarmalayıcısını kullanır" |
| 13.3 | Normal kullanıcı uçları hedef `userId` kabul etmez | aynı dosya → "normal kullanıcı uçları hedef kullanıcı kimliği KABUL ETMEZ" |
| 13.4 | Kullanıcı uçları admin servisini çağırmaz | aynı dosya → "kullanıcı uçları admin servisini çağırmaz" |
| 13.5 | `adminScope()` yalnızca admin servisinde çağrılır | aynı dosya → "actor sınırının kaynak kodda korunması" |
| 13.6 | Kullanıcı başka kullanıcının kaydını okuyamaz/değiştiremez/silemez | aynı dosya → "kullanıcı verisi ayrımı"<br>`e2e/security.spec.ts` → "Kullanıcı A, Kullanıcı B kaydına API üzerinden ulaşamaz" |
| 13.7 | Ham `userId` ile veri metodu çağrısı derleme hatasıdır | `DataScope` markalanmış tipi (`src/server/auth/actor.ts`); `npm run typecheck` |

## 14. Geçici parola sunucu koruması

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 14.1 | `requireUsableUser` geçici parolalı kullanıcıyı reddeder | `tests/auth-service.test.ts` → "geçici parola sunucu koruması" |
| 14.2 | Portföy ve işlem API'leri `PASSWORD_CHANGE_REQUIRED` döner | `e2e/security.spec.ts` → "geçici parolalı kullanıcı portföy API'sine erişemez" |
| 14.3 | Yönetim API'leri de reddeder | `e2e/security.spec.ts` → "geçici parolalı kullanıcı yönetim API'sine de erişemez" |
| 14.4 | Oturum, çıkış ve parola değiştirme uçları açıktır | `e2e/security.spec.ts` → "oturum ve parola değiştirme uçları geçici parolalı kullanıcıya açıktır" |
| 14.5 | Parola değişince bu cihaz sürer, diğer cihazlar kapanır | `tests/auth-service.test.ts` → "parola değiştirildikten sonra korumalı uçlar açılır"<br>`e2e/security.spec.ts` → "parola değiştirince bu cihazın oturumu sürer, diğer cihazlar kapanır" |

## 15. Kalıcı oturum modeli

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 15.0 | "Oturumu açık tut" işaretsizse kalıcı çerez oluşmaz; 8 saat / 30 dk; admin 8 saat / 15 dk | `tests/session-policy.test.ts`; `e2e/session.spec.ts` → "'oturumu açık tut' işaretsizse kalıcı çerez oluşmaz", "yönetici oturumu işaretli olsa bile kalıcı olmaz" |
| 15.1 | (İşaretli) 15 dk, 1 saat, 24 saat (ve 179 gün) hareketsizlik kullanıcıyı çıkarmaz | `tests/persistent-session.test.ts` → "hareketsizlik oturumu kapatmaz"<br>`e2e/session.spec.ts` → "15 dk, 1 saat ve 24 saat hareketsizlik kullanıcıyı çıkarmaz" |
| 15.2 | Tarayıcı kapatılıp açıldığında kalıcı çerezle oturum devam eder | `e2e/session.spec.ts` → "tarayıcı kapatılıp yeniden açıldığında oturum devam eder" |
| 15.3 | Kaydırmalı yenileme bitişi güvenli biçimde uzatır | `tests/persistent-session.test.ts` → "kaydırmalı yenileme"<br>`e2e/session.spec.ts` → "uzun aradan sonra bitiş zamanı sessizce ileri alınır" |
| 15.4 | Yenileme her API çağrısında DB yazmaz | `tests/persistent-session.test.ts` → "her API çağrısında veritabanına YAZILMAZ"<br>`e2e/session.spec.ts` → "her API çağrısı veritabanına yazmaz" |
| 15.5 | Kimlik 7 günde bir yenilenir; eski kimlik 60 sn sonra geçersiz | `tests/persistent-session.test.ts` → "oturum kimliği yenileme (rotation)" |
| 15.6 | Normal çıkış yalnızca mevcut cihazı kapatır | `tests/persistent-session.test.ts` → "normal çıkış yalnızca bu cihazın oturumunu kapatır"<br>`e2e/session.spec.ts` → "normal çıkış yalnızca bu cihazı kapatır" |
| 15.7 | "Tüm cihazlardan çıkış" bütün oturumları kapatır | `tests/persistent-session.test.ts` → "tüm cihazlardan çıkış bütün oturumları kapatır"<br>`e2e/session.spec.ts` → "'Tüm cihazlardan çıkış' bütün oturumları kapatır" |
| 15.8 | Parola sıfırlama bütün cihazları kapatır | `tests/persistent-session.test.ts` → "yönetici parola sıfırlaması bütün cihazları kapatır"<br>`e2e/session.spec.ts` → "yönetici parola sıfırlaması" |
| 15.9 | Pasifleştirme bütün cihazları kapatır | `tests/persistent-session.test.ts` → "pasifleştirme bütün cihazları anında kapatır"<br>`e2e/session.spec.ts` → "kullanıcı pasifleştirme" |
| 15.10 | Silinmiş / iptal edilmiş oturum çerezi ile erişim reddedilir | `tests/persistent-session.test.ts` → "silinmiş / iptal edilmiş oturum kimliği reddedilir"<br>`e2e/security.spec.ts` → "iptal edilmiş (revoke) oturum çerezi ile erişim reddedilir" |
| 15.11 | Auth token / oturum kimliği localStorage / sessionStorage / IndexedDB'de yok | `e2e/session.spec.ts` → "oturum kimliği JavaScript'ten okunamaz ve tarayıcı deposunda yoktur" |
| 15.12 | Mobil PWA ve masaüstü aynı portföyü görür | `e2e/session.spec.ts` → "masaüstünde eklenen işlem mobil görünümde de görünür" |
| 15.13 | Yönetici oturumları görür (ham IP yok) ve kapatır | `tests/persistent-session.test.ts` → "yönetici belirli bir oturumu veya bütün oturumları iptal edebilir"<br>`e2e/session.spec.ts` → "yönetici panelinden oturumları görüp kapatma" |
| 15.14 | Üretimde çerez `__Host-` önekli, Secure, Path=/, Domain'siz | `tests/session-cookie.test.ts`; `src/server/security/config.ts` |
| 15.15 | Eski device-mode testleri kaldırıldı; yeni davranışla çelişen test yok | `tests/deployment-surface.test.ts` → "giriş ekranı: tek ve kalıcı oturum modeli" |

## 16. CSRF ve güvenlik başlıkları

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 16.1 | İmzalı jeton üretilir ve doğrulanır | `tests/csrf.test.ts` → "imzalı CSRF jetonu" bloğu |
| 16.2 | Kurcalanmış veya başka anahtarla imzalanmış jeton reddedilir | aynı dosya |
| 16.3 | Origin ve Sec-Fetch-Site kontrolü | aynı dosya → "origin kontrolü" bloğu |
| 16.4 | CSRF'siz mutation reddedilir | `e2e/security.spec.ts` → "CSRF jetonu olmayan mutation reddedilir" |
| 16.5 | Geçersiz CSRF jetonu reddedilir | `e2e/security.spec.ts` → "geçersiz CSRF jetonu reddedilir" |
| 16.6 | Farklı origin reddedilir | `e2e/security.spec.ts` → "farklı origin'den gelen mutation reddedilir" |
| 16.7 | Okuma istekleri jeton gerektirmez | `e2e/security.spec.ts` → "okuma istekleri CSRF jetonu gerektirmez" |
| 16.8 | Jeton hiçbir tarayıcı deposuna yazılmaz | `e2e/security.spec.ts` → "CSRF jetonu sayfada meta etiketiyle taşınır, depoya yazılmaz" |
| 16.9 | Güvenlik başlıkları gönderilir | `e2e/security.spec.ts` → "güvenlik başlıkları" bloğu |
| 16.10 | Uygulama CSP altında sorunsuz çalışır | `e2e/security.spec.ts` → "uygulama CSP altında sorunsuz çalışır" |

## 17. Dağıtık hız sınırlayıcı

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 17.1 | Ham IP ve kullanıcı adı saklanmaz | `tests/rate-limit-distributed.test.ts` → "anahtar gizleme" bloğu |
| 17.2 | Postgres uygulaması RPC'ye yalnızca özet gönderir | aynı dosya → "RPC'ye ham anahtar göndermez" |
| 17.3 | Sınırlayıcı hata verirse istek reddedilir (fail closed) | aynı dosya → "RPC hatasında AÇIK KALMAZ" |
| 17.4 | Üretimde bellek sınırlayıcısına sessizce düşülmez | aynı dosya → "üretimde bellek sınırlayıcısına sessizce düşülmez" bloğu |
| 17.5 | Sayaç güncellemesi atomiktir | aynı dosya → "sayaç güncellemesi satır kilidiyle atomiktir" |
| 17.6 | Başarılı girişte sayaç sıfırlanır | aynı dosya → "başarılı girişte sayaç sıfırlanır" |

## 18. Veritabanı bütünlüğü

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 18.1 | Kullanıcı başına tek portföy | `tests/integrity.test.ts` → "migration bütünlük kuralları" |
| 18.2 | İşlem portföyü sahibiyle uyumlu (composite FK) | aynı dosya |
| 18.3 | Birim ürün kataloğuyla uyumlu | aynı dosya → "birim tutarlılığı" bloğu |
| 18.4 | **Eşzamanlı iki satış oversell oluşturamaz** | aynı dosya → "EŞZAMANLI iki satış birlikte eldeki miktarı aşamaz" |
| 18.5 | Çok sayıda eşzamanlı satışta yalnızca karşılanabilir olanlar yazılır | aynı dosya |
| 18.6 | Alışı silmek/azaltmak sonraki satışları geçersiz kılamaz | aynı dosya |
| 18.7 | Migration mevcut veriyle güvenle çalışır | aynı dosya → "migration mevcut veriyle güvenli çalışır" |

## 19. Denetim kaydı sertleştirme

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 19.1 | UPDATE/DELETE tetikleyici ile engellenir | `tests/integrity.test.ts` → "denetim kayıtları tetikleyici ile değiştirilemez" |
| 19.2 | Uygulamada düzenleme/silme ucu yoktur | `tests/authorization-matrix.test.ts` → route matrisi (yalnızca GET) |
| 19.3 | Silme girişimi, sonucu ve hatası dürüstçe kaydedilir | `tests/admin-service.test.ts` → "silme sırasında hata olursa başarısızlık dürüstçe kaydedilir" |
| 19.4 | Son denetim kaydı yazılamazsa gizlenmez | aynı dosya → "son denetim kaydı yazılamazsa bu durum gizlenmez" |
| 19.5 | Parola / finansal içerik yazılmaz | aynı dosya → "denetim kaydına parola veya finansal içerik yazılmaz" |

## 20. Veritabanı yetki sınırı ve RLS testleri (pgTAP + gerçek JWT)

`supabase/tests/rls.test.sql` — **184 test**. Çalıştırma: `npm run test:db`
(Supabase CLI + Docker; `supabase db reset` ile 0001→0012 temiz uygulanır).

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 20.1 | Kritik RPC'ler anon/authenticated için kapalı, service_role için açık | pgTAP "FONKSİYON YETKİ MATRİSİ" (`has_function_privilege`) |
| 20.2 | Dahili yardımcılar ve tetikleyici fonksiyonları hiçbir role açık değil | pgTAP "Dahili yardımcılar ... HİÇBİR role açık değildir" |
| 20.3 | Yeni fonksiyonlar varsayılan olarak anon/authenticated'a açılmaz | pgTAP "ALTER DEFAULT PRIVILEGES" (gerçek fonksiyon oluşturulur) |
| 20.4 | anon hiçbir tabloyu okuyamaz/yazamaz; authenticated yalnızca SELECT | pgTAP "TABLO YETKİ MATRİSİ" (`has_table_privilege`) |
| 20.5 | authenticated kendi portföyüne bile doğrudan yazamaz — GRANT katmanı | pgTAP "permission denied for table transactions" mesajlı `throws_ok` |
| 20.6 | authenticated kritik RPC'leri çağıramaz | pgTAP "permission denied for function ..." |
| 20.7 | Sahip bağlamında composite FK ve birim tetikleyicisi çalışır | pgTAP `23503` / `23514` |
| 20.8 | Yazma politikaları kaldırıldı, SELECT politikaları korundu | pgTAP `pg_policies` envanteri |
| 20.9 | Provisioning tetikleyicisi ve onarım idempotent; `lock_user_portfolio` portföy oluşturmaz | pgTAP "PROVISIONING" bloğu |
| 20.10 | Kalıcı oturum şeması; temizlik yalnızca iptal/süresi dolanı siler | pgTAP "KALICI OTURUM ŞEMASI" |
| 20.11 | Gerçek anon anahtarı ve authenticated JWT ile PostgREST üzerinden yazma reddedilir, okuma RLS kapsamlı | `npm run test:data-api` → `scripts/data-api-probe.mjs` (46 beklenti) |
| 20.12 | Migration metni beklenen kuralları taşır (pgTAP çalışmayan ortam için) | `tests/database-boundary.test.ts` |
| 20.13 | GET /api/portfolio veri oluşturmaz; onarım idempotent | `tests/provisioning.test.ts` |
| 20.14 | side/productId/NaN/negatif girdiler 400 ile reddedilir | `tests/transaction-input.test.ts` |
| 20.15 | Üç sayaçlı hız sınırı; başarılı giriş yalnızca kombinasyonu sıfırlar | `tests/rate-limit-buckets.test.ts` |
| 20.16 | Üretimde APP_ORIGIN zorunlu; Host'tan türetilmez | `tests/production-origin.test.ts` |
| 20.17 | Güvenilmeyen vekilde X-Forwarded-For yok sayılır | `tests/client-ip.test.ts` |
| 20.18 | Kaynak ZIP'i `/` ayraçlı, CRC ve giriş sayısı doğrulanır | `tests/database-boundary.test.ts` → "kaynak paketi (ZIP)" |

> Çıkış kodları: `0` geçti, `1` başarısız, **`2` çalıştırılamadı** (CLI veya
> Docker yok). Komut ortam uygun değilse testleri çalıştırılmış gibi
> raporlamaz. Son koşum: yerel Supabase yığınında 184/184 geçti; uzak proje için docs/STAGING.md.

## 21. Temiz kaynak paketi

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 21.1 | ZIP `.git`, `node_modules`, `.next`, `.data`, test çıktıları, tsbuildinfo içermez | `npm run package:source` (yol denetimi + arşiv doğrulaması) |
| 21.2 | Gerçek `.env` dosyaları girmez, `.env.example` girer | aynı komut |
| 21.3 | Paket içinde secret izi yoktur | aynı komut (yeniden açıp tarar) |
| 21.4 | SHA-256 ve dosya manifesti üretilir | `dist/Altin-Takip-Source.zip.sha256`, `dist/Altin-Takip-Source.manifest.txt` |


Ekran görüntüleri: `docs/screenshots/mobile.png` ve `docs/screenshots/desktop.png`
(`e2e/screenshots.spec.ts` tarafından üretilir).

## 22. Muhasebe motoru (Sprint 1)

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 22.1 | ÖRNEK 1 — ağırlıklı ortalama (15 g, 57.000, 3.800; 4.100 → 61.500, +4.500) | `tests/accounting.test.ts` → "ÖRNEK 1"; pgTAP "ÖRNEK 1"; `e2e/portfolio.spec.ts` → "ÖRNEK 1" |
| 22.2 | ÖRNEK 2 — market baseline + alış (526.000 / 5.009,52…; Karışık maliyet; K/Z 0'dan başlar) | `tests/accounting.test.ts` → "ÖRNEK 2"; `e2e/portfolio.spec.ts` → "bugünden itibaren takip" |
| 22.3 | ÖRNEK 3 — çeyrek (14 adet, 154.600, 11.042,857…) | `tests/accounting.test.ts` → "ÖRNEK 3"; `e2e/portfolio.spec.ts` → "gerçek maliyet (toplam)" |
| 22.4 | ÖRNEK 4 — satış ortalamayı değiştirmez; realized/unrealized ayrı; toplam 4.900 | `tests/accounting.test.ts` → "ÖRNEK 4"; pgTAP "ÖRNEK 4"; `e2e/portfolio.spec.ts` → "ÖRNEK 4" |
| 22.5 | ÖRNEK 5 — masraflar maliyete eklenir (50.600 / 5.060) | `tests/accounting.test.ts`; pgTAP; E2E "ÖRNEK 5" |
| 22.6 | ÖRNEK 6 — toplam ödenen modu; işçilik ikinci kez eklenmez | `tests/accounting.test.ts`; pgTAP "ÖRNEK 6" |
| 22.7 | ÖRNEK 7 — eşzamanlı iki 7 g satış 10 g'ı aşamaz | `tests/integrity.test.ts` → "ÖRNEK 7"; Postgres satır kilidi (`0010`) |
| 22.8 | ÖRNEK 8 — idempotency: tek işlem, replay, farklı içerik conflict | `tests/integrity.test.ts` → "ÖRNEK 8"; pgTAP "ÖRNEK 8"; E2E "aynı istek kimliği"; `accounting:smoke` |
| 22.9 | ÖRNEK 9 — geçmiş alış iptali sonraki satışı aşırıya düşürürse reddedilir | `tests/integrity.test.ts` → "ÖRNEK 9"; pgTAP "ÖRNEK 9" |
| 22.10 | ÖRNEK 10 — 0,1 + 0,2 = 0,3; kayan nokta artığı yok | `tests/accounting.test.ts` → "ÖRNEK 10"; pgTAP; E2E "ondalık dize" |
| 22.11 | Yeni kullanıcı boş portföyle başlar; örnek varlık yok | `tests/accounting.test.ts` → "boş portföy"; E2E "yeni hesap tamamen boş açılır" |
| 22.12 | OPENING_BALANCE snapshot'ı sonradan değişmez; stale fiyatla oluşturulamaz | pgTAP "MARKET_BASELINE" bloğu; `tests/commands.test.ts` |
| 22.13 | Pozisyon sıfırlanınca maliyet artığı kalmaz; adet ürününe ondalık girilemez; 6 ondalık gram | `tests/accounting.test.ts` → "pozisyon kuralları"; `tests/commands.test.ts` |
| 22.14 | Farklı ürünlerin maliyetleri karışmaz; geçmiş değişince sonraki durum yeniden hesaplanır | `tests/accounting.test.ts`; `tests/integrity.test.ts` → "geçmiş tarihli işlem" |
| 22.15 | Void hard delete olmaz; düzeltme eski kaydı REPLACED yapar | `tests/integrity.test.ts` → "void / replacement"; E2E "iptal hard delete değildir", "düzeltme" |
| 22.16 | Admin yalnız okur; User A, User B işlem ID'siyle işlem yapamaz | `tests/admin-service.test.ts`; `tests/authorization-matrix.test.ts`; `e2e/security.spec.ts` |
| 22.17 | GET uçları veri değiştirmez; CSRF'siz mutation reddedilir | E2E "GET uçları veri değiştirmez"; `e2e/security.spec.ts` → CSRF bloğu |
| 22.18 | Dashboard realized/unrealized karıştırmaz; baseline varsa "Takip başlangıcından itibaren" etiketi | `tests/accounting.test.ts` → ÖRNEK 2/4; E2E "bugünden itibaren takip" |
| 22.19 | Mock fiyat gerçek fiyat gibi etiketlenmez | `tests/prices.test.ts`; E2E "fiyat kaynağı test verisi" |
| 22.20 | Özellik testleri: miktar negatif olmaz, sıfırda maliyet sıfır, satış ortalamayı korur, bölünmüş alış = toplu alış, replay deterministik | `tests/accounting.test.ts` → "özellik testleri" |
| 22.21 | Defter ↔ projeksiyon tutarlılığı | `npm run accounting:verify`; pgTAP "ledger_verify" |
| 22.22 | 390/768/1440 px görünümleri geçer | Playwright projeleri; E2E "tüm ekranlarda yatay taşma yoktur" |

## 23. Muhasebe bütünlüğü (Sprint 1.1)

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 23.1 | service_role transactions tablosuna doğrudan INSERT/UPDATE/DELETE yapamaz | pgTAP §11 "service_role transactions … (0011)"; `scripts/data-api-probe.mjs` |
| 23.2 | service_role price_snapshots tablosuna doğrudan INSERT yapamaz | pgTAP §11; Data API sondası |
| 23.3 | Aynı rol `ledger_append` ile yazabilir; projeksiyon defterle eşleşir | pgTAP §11 lives_ok + ledger_verify; sonda "ledger_verify" |
| 23.4 | Uygulama kodunda defter tablolarına `.from()` erişimi yok | `tests/accounting-integrity.test.ts` → "statik sınır" |
| 23.5 | Baseline pozisyon tam kapanıp ACTUAL ile yeniden açılınca kalite ACTUAL; tarihsel köken korunur | `tests/accounting-integrity.test.ts` §1; pgTAP §13 "cumhuriyet-altini"; `accounting:smoke` |
| 23.6 | Tam kapanmış pozisyon: 0 / 0 / null / holding false / realized korunur | `tests/accounting-integrity.test.ts` §1; pgTAP §13 |
| 23.7 | Girilen birim fiyat ile efektif maliyet ayrı (5.000 / 5.060); TOTAL_AMOUNT'ta quoted null | `tests/accounting-integrity.test.ts` §2; pgTAP ÖRNEK 5/6; E2E "sayı girişi" |
| 23.8 | 2026-02-30 reddedilir, 2028-02-29 kabul; 400 döner (500 değil) | `tests/accounting-integrity.test.ts` §3; pgTAP §13; E2E "aynı gün saatli işlemler" |
| 23.9 | Aynı gün 10:00 alış / 11:00 satış geçer; ters sıra oversell; tarih/saat düzeltmesi oversell yaratırsa reddedilir | `tests/accounting-integrity.test.ts` §3; pgTAP §13; E2E |
| 23.10 | Gelecek / bayat / ters makaslı / başka ürünlü / TL dışı anlık görüntü reddedilir | `tests/accounting-integrity.test.ts` §4; pgTAP §13 |
| 23.11 | Kısmi değerleme etiketlenir; gerçekleşmiş K/Z etkilenmez | `tests/accounting-integrity.test.ts` §5; `src/components/dashboard-view.tsx` (`partial-valuation`) |
| 23.12 | "1 2" ve "5.000" reddedilir; Türkçe biçimler doğru okunur; istemci-sunucu aynı sonuç | `tests/accounting-integrity.test.ts` §6; E2E "sayı girişi" |
| 23.13 | Eski kayıtlar migration/normalizasyon sonrası doğru okunur | `tests/accounting-integrity.test.ts` §2 "eski kayıtlar"; 0011 backfill + `accounting:verify` |
| 23.14 | 0011 idempotent; `accounting:verify` tutarsızlık 0 | `npm run test:db`; migration ikinci kez uygulanır; `npm run accounting:verify` |

## 24. Staging, senkronizasyon ve son doğruluk düzeltmeleri (Sprint 2)

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 24.1 | Merkezi quote doğrulaması: 2 saat eski providerTimestamp, bayat fetchedAt, başka ürün, uyuşmayan sağlayıcı/piyasa, ters makas, gelecek zaman reddedilir; 5 dk tolerans çalışır | `tests/sprint2.test.ts` §1; pgTAP §14 "Sağlayıcı zamanı 2 saat eskiyse", "stale_after_ms", "5 dakikalık" |
| 24.2 | valuationStatus: A boş / B full / C partial / D none — D'de kartlar "Fiyat verisi kullanılamıyor", 0 TL değil; maliyet ve gerçekleşmiş K/Z görünür | `tests/sprint2.test.ts` §2; `e2e/valuation.spec.ts` |
| 24.3 | CLOSED portföy: gerçekleşmiş K/Z ve düğmeler görünür; "Henüz altın eklenmedi" denmez | `tests/sprint2.test.ts` §3; `e2e/valuation.spec.ts` → "CLOSED" |
| 24.4 | Yerel demo ve sunucu idempotency eşit: aynı kimlik + aynı içerik replay, farklı içerik conflict; replace replay aynı biçim (iki pozisyon) | `tests/sprint2.test.ts` §4/§4b; pgTAP §14 "Replay düzeltme" |
| 24.5 | Sayısal sınırlar: küçük miktar × büyük tutar, brüt/birikimli taşma P0004/400; sıkı ayrıştırma (1e3, NaN, bozuk UUID) | `tests/sprint2.test.ts` §5 (özellik testi dâhil); pgTAP §14 |
| 24.6 | Hesap silme cascade'i gerçek auth ucuyla: 7 tablo sıfır; cleanup sessiz geçmez | `scripts/data-api-probe.mjs` "cascade"; pgTAP §14 "auth.users silme" |
| 24.7 | Sürüm yalnızca gerçek değişiklikte artar; replay/başarısız artırmaz; elle değiştirilemez | `tests/sprint2.test.ts` §7; pgTAP §14; sonda "ledger_revision" |
| 24.8 | Telefon–PC: masaüstü BUY → mobil ≤15 sn; mobil VOID → masaüstü ≤15 sn; User B görmez; `/api/portfolio/version` ETag/304 | `e2e/sync.spec.ts` |
| 24.9 | Staging araçları fail closed; secret yazdırmaz; env dosyası pakete girmez | `scripts/staging/*.mjs`; `scripts/package-source.mjs` desenleri; `npm run staging:doctor` |
| 24.10 | Gerçek staging E2E (§12 senaryoları) | `e2e-staging/staging.spec.ts` (`npm run test:staging`; dış kimlik doğrulama gerektirir) |

## 25. Çoklu fiyat kaynağı ve kaynak seçimi (Sprint 3)

| # | Kabul kriteri | Test |
| --- | --- | --- |
| 25.1 | Sağlayıcı sözleşmesi: ham yanıt → kanonik quote; bilinmeyen sembol atlanır; alış/satış ters çevrilmez; para birimi ve zaman damgası doğrulanır | `tests/price-providers.test.ts` §1–§3 |
| 25.2 | Lisans kapısı fail closed: değişken eksikse `NOT_CONFIGURED`, izin `true` değilse `LICENSE_REQUIRED`; bu durumda ağa çıkılmaz | `tests/price-providers.test.ts` §4; `tests/price-sources.test.ts` §1 |
| 25.3 | Lisanssız kaynak etkinleştirilemez (409) ve kullanıcıya sunulmaz; API üzerinden zorlama da reddedilir | `tests/price-sources.test.ts` §1/§3; `e2e/price-sources.spec.ts` → "lisanssız kaynağı etkinleştiremez" |
| 25.4 | Alım idempotenttir ve paralel koşum tekilleşir: aynı `run_key` iki kez uygulanmaz, ikinci eşzamanlı koşum `SKIPPED` | `tests/price-sources.test.ts` §2; pgTAP §15 |
| 25.5 | Kalite kapısı: ters makas, aşırı sıçrama, bayat/gelecek sağlayıcı zamanı, sıfır/negatif fiyat karantinaya alınır ve değerlemeye girmez | `tests/price-sources.test.ts` §2; `tests/price-providers.test.ts` §5; pgTAP §15 |
| 25.6 | Kullanıcı yalnızca açık kaynakları görür; başka portföyün tercihini okuyamaz/değiştiremez | `tests/price-sources.test.ts` §3; pgTAP §15 |
| 25.7 | Kaynak değişimi açık onay ister, olay kaydı ve denetim izi üretir | `e2e/price-sources.spec.ts` → "değişim onay ister"; `tests/price-sources.test.ts` §3 |
| 25.8 | **Sessiz fallback yok:** aktif kaynak düşerse başka sağlayıcıya geçilmez; "fiyat yok / bayat" gösterilir, 0 TL gösterilmez | `tests/price-sources.test.ts` §4; `e2e/valuation.spec.ts` |
| 25.9 | Kaynak değişimi BUY/SELL tutarlarını, `MARKET_BASELINE` snapshot'ını ve gerçekleşmiş K/Z'yi değiştirmez | `tests/price-sources.test.ts` §4; `e2e/price-sources.spec.ts` → "geçmişi değiştirmez" |
| 25.10 | Karşılaştırma ekranı yalnızca gösterimdir; aktif değerleme kaynağını değiştirmez | `e2e/price-sources.spec.ts` → "compare-table" |
| 25.11 | Panelde aktif kaynak, piyasa, son güncelleme ve "Gerçek piyasa verisi değil" etiketi görünür; "Harem resmî" gibi ifade hiçbir yerde geçmez | `e2e/price-sources.spec.ts` → "panelde aktif kaynak"; `tests/price-providers.test.ts` §6 |
| 25.12 | Cron ucu secret olmadan çalışmaz (403); secret tanımsızsa uç kapalıdır | `e2e/price-sources.spec.ts` → "zamanlanmış alım ucu"; `tests/authorization-matrix.test.ts` |
| 25.13 | Yönetici MFA zorunlu: doğrulanmamış oturum yönetim uçlarında 403; TOTP ±1 pencere; 5 denemede kilit; kurtarma kodu tek kullanımlık | `tests/price-sources.test.ts` §5; `e2e/price-sources.spec.ts` → "MFA doğrulanmadan" |
| 25.14 | MFA secret'ı dinlenmede şifreli (AES-256-GCM); açık secret sütunu yok; kurtarma kodları yalnızca özet | `tests/price-sources.test.ts` §5; pgTAP §15 "admin_mfa" |
| 25.15 | Normal kullanıcı MFA olmadan çalışır; MFA yalnızca yöneticide zorunludur | `e2e/price-sources.spec.ts` → "normal kullanıcı ikinci faktör olmadan" |
| 25.16 | Kullanıcı kendi verisini CSV indirir, silme talebi gönderir; gizlilik sayfası bağlayıcı teklif olmadığını belirtir | `e2e/price-sources.spec.ts` → "CSV indirebilir" |
| 25.17 | Fiyat tabloları istemciye kapalı; yazma yalnızca RPC ile; tarihçe ve olay kaydı append-only | pgTAP §15; `npm run test:data-api` |
| 25.18 | Sağlayıcı hataları güvenli koda indirgenir; ham yanıt, URL ve anahtar sızmaz | `tests/price-providers.test.ts` §4; `tests/security-surface.test.ts` |
| 25.19 | Canlı sağlayıcı testi credential yoksa NOT_RUN raporlanır; eksik ayarlar yalnızca değişken adıyla listelenir | `npm run price:contract` |
| 25.20 | Fiyat alımı uçtan uca: katalog eşitleme → alım → karantina → seçim → değerleme | `npm run price:smoke` (yerel Supabase) |
| 25.21 | Sağlık ucu kimliksiz yalın durum döner; ayrıntı yalnızca cron secret'ıyla açılır ve secret/adres sızdırmaz | `tests/authorization-matrix.test.ts`; `e2e/price-sources.spec.ts` → "sağlık ucu" |
| 25.22 | Katalog hiç eşitlenmemiş yeni kurulumda kaynak okuma/seçme çalışır; başarısız eşitleme önbelleğe alınmaz | `tests/price-sources.test.ts` §1 |
| 25.23 | Üretimde kaynak seçili değilken test verisine düşülmez: anlık görüntü "unavailable", MARKET_BASELINE oluşmaz | `tests/price-sources.test.ts` §4b |
| 25.24 | CSV dışa aktarma ayırıcı/tırnak/satır sonunu kaçırır ve `=`, `+`, `-`, `@` ile başlayan serbest metni formül olarak çalıştırmaz | `tests/csv-export.test.ts` |
| 25.25 | Paylaşılan bileşene verilen `data-testid` DOM'a ulaşır (sessizce düşen prop yakalanır) | `tests/deployment-surface.test.ts` → "arayüz sözleşmesi" |
| 25.26 | Yönetim fiyat kaynakları ekranı 390 px'te yatay taşma üretmez (uzun değişken adları ve düğme grubu dâhil) | `e2e/price-sources.spec.ts` → `expectNoHorizontalOverflow` |
| 25.27 | Piyasa arayüzde okunur adıyla görünür ve kaynak hangi yoldan gelirse gelsin aynı adla etiketlenir | `e2e/portfolio.spec.ts` → "fiyat kaynağı test verisi olarak etiketlenir", "MARKET_BASELINE" |
