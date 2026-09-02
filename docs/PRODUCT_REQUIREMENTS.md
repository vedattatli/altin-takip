# Ürün Gereksinimleri

## 1. Amaç

Türkiye'de altın biriktiren kişilerin portföylerini tek yerden takip edebilmesi. Kullanıcı ne kadar
altını olduğunu, ne kadar maliyetle aldığını, bugün bozdurursa ne alacağını ve kâr/zarar durumunu
görebilmelidir.

## 2. Ürün ilkeleri

| İlke | Anlamı |
| --- | --- |
| Dürüst veri | Test verisi gerçek fiyat gibi gösterilmez. Bayat veriye "güncel" denmez. Fiyat yoksa sıfır değil "fiyat yok" yazılır. |
| Kurulum yok | Tarayıcıda çalışır. EXE, Excel, Python, yönetici izni gerekmez. |
| Mobil öncelikli | 390 px'te yatay kaydırma olmaz; 1440 px'te boş görünmez. |
| Koyu arayüz | Uygulama koyu temadır; rakamlar ve kâr/zarar renkleri yüksek kontrastlıdır. |
| Kişiye özel değil | Fotoğraf, kişi adı veya kişiye özel logo kullanılmaz. Ürün adı tek dosyadan yönetilir. |
| Kapalı erişim | Herkese açık kayıt yoktur. Hesapları yalnızca yönetici açar. |

## 3. Platform ve dağıtım

- Responsive web uygulaması + PWA.
- Windows, macOS, Android, iPhone tarayıcıları.
- **Hiçbir yerel program kurulumu gerekmez:** EXE, MSI, BAT, tarayıcı eklentisi veya yerel
  yardımcı üretilmez. Bütün özellikler normal HTTPS web uygulaması olarak çalışır.
- Ana ekrana/masaüstüne eklenebilir; ancak **PWA kurulumu tamamen isteğe bağlıdır** ve hiçbir
  özellik için zorunlu değildir. Kurulu PWA ile tarayıcı kullanımı arasında görsel ve işlevsel
  fark yoktur.
- Çevrimdışıyken bilgilendirme sayfası gösterilir; canlı fiyat varmış gibi davranılmaz.

### 3.1 Cihaz türü

Giriş ekranında "Kişisel cihaz" ve "Şirket / ortak cihaz" seçenekleri bulunur.
**Güvenli varsayılan ortak cihazdır.**

Şirket / ortak cihaz modunda:

- kalıcı oturum kullanılmaz (çerez tarayıcı kapanınca silinir),
- "beni hatırla" seçeneği gösterilmez,
- portföy veya oturum jetonu `localStorage` / IndexedDB gibi depolara yazılmaz,
- hassas API yanıtları servis çalışanı önbelleğine alınmaz,
- servis çalışanı kaydedilmez; varsa kaldırılır ve önbellekler temizlenir,
- PWA kurulum çağrısı gösterilmez,
- bildirim/push veya başka bir cihaz izni istenmez,
- 15 dakika hareketsizlikte otomatik çıkış yapılır.

Her iki modda da oturum sunucu tarafında yönetilir ve jeton yalnızca
`Secure` + `HttpOnly` + `SameSite=Lax` çerezde taşınır. Kullanıcı portföyü bulut veritabanında
saklanır; cihazlar arası senkronizasyon sunucu üzerinden yapılır.

## 4. Kullanıcı modeli

### 4.1 Kayıt ve giriş

- **Herkese açık kayıt ekranı yoktur.** "Kayıt Ol" bağlantısı bulunmaz.
- Kullanıcılar yalnızca yönetici tarafından oluşturulur.
- Giriş ekranında **yalnızca kullanıcı adı ve parola** alanı bulunur.
- E-posta, telefon, OTP, sihirli bağlantı ve sosyal giriş **kullanılmaz**.
- Giriş hatasında "kullanıcı bulunamadı" / "parola yanlış" ayrımı yapılmaz; tek genel mesaj gösterilir.
- Başarılı oturum sunucu tarafında yönetilen güvenli çerezle sürdürülür; kalıcılığı seçilen cihaz
  türüne bağlıdır (bkz. 3.1). Çıkış yapma özelliği bulunur.
- Giriş ekranında parola göster/gizle düğmesi bulunur.

### 4.2 Kullanıcı adı kuralları

- Büyük/küçük harfe duyarsız; normalize edilerek saklanır ve benzersizdir.
- Uzunluk 3–32 karakter, harf ile başlar.
- İzin verilen karakterler: `a-z`, `0-9`, `.`, `_`, `-`
- **Boşluk kullanılamaz.** Baştaki/sondaki boşluklar silinir.
- Ayırıcı (`. _ -`) ile bitemez, art arda gelemez.
- Türkçe harfler ASCII karşılığına çevrilir: `ç→c, ğ→g, ı→i, İ→i, ö→o, ş→s, ü→u`.
- Kullanıcı adı **tek başına kimlik doğrulama unsuru değildir**; parola zorunludur.

### 4.3 Parola kuralları

- En az 10, en fazla 128 karakter.
- En az bir harf ve bir rakam.
- Yaygın parolalar, ardışık diziler (`123456`, `abcdef`), tek karakter tekrarı reddedilir.
- Kullanıcı adını içeremez.
- Girişte hız sınırı ve tekrarlanan başarısızlıkta artan bekleme uygulanır.

### 4.4 Parola yaşam döngüsü

1. Yönetici kullanıcıyı oluştururken **geçici parola** belirler.
2. Kullanıcı ilk girişte parola değiştirme ekranına yönlendirilir (`must_change_password`).
3. Kullanıcı mevcut parolasını doğrulayarak yeni parola belirler.
4. Parola değiştiğinde veya yönetici sıfırladığında **tüm cihazlardaki oturumlar düşer**.
5. Yönetici mevcut parolayı **hiçbir zaman göremez**; yalnızca yeni geçici parola atayabilir.

## 5. Yönetici paneli

| Yetenek | Durum |
| --- | --- |
| Kullanıcıları listele | Var |
| Kullanıcı ara | Var |
| Yeni kullanıcı oluştur (kullanıcı adı, görünen ad, geçici parola) | Var |
| Kullanıcıyı pasifleştir / yeniden aktifleştir | Var |
| Parolayı yeni geçici parolayla sıfırla | Var |
| Kullanıcıyı kalıcı sil (açık onay ile) | Var |
| Kullanıcının portföyünü görüntüle (maliyet, bozdurma, yeniden alım, kâr/zarar) | Var |
| Kullanıcı adına finansal kayıt düzenleme | **Kapalı** (ayrı yetki olarak modellendi) |

### 5.1 Pasifleştirme ve silme

- **Varsayılan işlem pasifleştirmedir.** Kullanıcı giriş yapamaz, açık oturumları düşer, verileri korunur.
- **Kalıcı silme** ayrı ve açık onay ister: hedefin kullanıcı adı birebir yazılmalıdır. Silinecek
  portföy ve işlem sayısı ekranda belirtilir.
- Yönetici kendi hesabını pasifleştiremez veya silemez. Son aktif yönetici kaldırılamaz.

## 6. Portföy

### 6.1 Panel (dashboard)

İlk hesap **kesinlikle boş** başlar. Örnek varlık eklenmez.

- Toplam bozdurma değeri (piyasanın **alış** fiyatına göre)
- Toplam yeniden alım değeri (piyasanın **satış** fiyatına göre)
- Toplam maliyet (işçilik dâhil)
- Kâr/zarar (gerçekleşmemiş) ve yüzdesi
- "Henüz altın eklenmedi" boş durumu ve belirgin "Altın Ekle" çağrısı
- Fiyat kaynağı, piyasa, veri durumu ve son fiyat zamanı — panelin altında tek satırlık şeritte,
  ortada yer kaplamadan; "gerçek piyasa verisi değil" uyarısı her zaman görünür

### 6.2 İşlem ekleme

Alanlar: altın türü, işlem türü (alış/satış), miktar, birim (gram/adet), işlem tarihi,
birim fiyat **veya** toplam tutar, isteğe bağlı işçilik/komisyon, isteğe bağlı not.

Doğrulama: miktar > 0, adet ürünlerde tam sayı, birim fiyat > 0, işçilik ≥ 0, tarih gelecekte
olamaz, satış miktarı eldeki miktarı aşamaz.

### 6.3 Ürün kataloğu

Gram Altın, Has Altın, 24 Ayar Külçe, Özel Gramajlı Külçe, 22 Ayar Bilezik, 18 Ayar Altın,
14 Ayar Altın, 8 Ayar Altın, Yeni/Eski Çeyrek, Yeni/Eski Yarım, Yeni/Eski Tam, Cumhuriyet Altını,
Ata Altın, Reşat Altın, Hamit Altın, İkibuçuk Altın, Beşli Altın, Gremse Altın.

Katalog tek merkezden yönetilir: `src/domain/catalog.ts`.

### 6.4 Hesaplama

- Maliyet yöntemi: **ağırlıklı ortalama (kayan ortalama)**.
- Alışta işçilik maliyete eklenir; satışta net gelirden düşülür.
- Bozdurma değeri = kalan miktar × piyasa alış fiyatı.
- Yeniden alım değeri = kalan miktar × piyasa satış fiyatı.
- Gerçekleşmemiş kâr/zarar = bozdurma değeri − kalan maliyet.

## 7. Fiyat verisi

- Bu sürümde yalnızca `MockPriceProvider` kullanılır ve **Test Verisi** olarak etiketlenir.
- Her fiyat kaydı şu alanları taşır: `productId`, `buyPrice`, `sellPrice`, `currency`, `market`,
  `provider`, `providerTimestamp`, `fetchedAt`, `status`.
- Alış ve satış birbirine çevrilmez.
- Bir sağlayıcı başarısız olduğunda başka piyasaya **sessiz geçiş yapılmaz**.
- Hiçbir siteden izinsiz veri çekilmez.

## 8. Demo modu

- Yalnızca geliştirme ortamında ve `NEXT_PUBLIC_ENABLE_DEMO_MODE=true` iken `/demo` adresinde açılır.
- Üretim derlemesinde 404 döner.
- Giriş ekranında demo düğmesi **görünmez**.
- Demo kullanıcıları gerçek Supabase kullanıcısı gibi gösterilmez.
- Demo verileri yalnızca tarayıcıda (IndexedDB) tutulur; cihazlar arasında senkronize olmadığı
  ekranda açıkça belirtilir.

## 9. Bu sürümün kapsamı dışında

Gerçek fiyat sağlayıcısı, KAYSARDER/Sarraf TV entegrasyonu, SMS OTP, push bildirim, mağaza paketi,
ödeme/abonelik, production deployment, alan adı kurulumu, çoklu dil, mikroservis mimarisi.
