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

### 3.1 Oturum ve cihazlar

Giriş ekranında cihaz türü sorulmaz; tek bir tercih vardır: **"Bu cihazda oturumumu açık tut"**.

- **İşaretli:** kalıcı çerez, 180 gün kaydırmalı oturum (aktivitede bitiş ≤ 24 saatte bir
  ileri alınır), kimlik 7 günde bir sessizce yenilenir. Kullanıcı açıkça çıkış yapana,
  yönetici iptal edene, parola değişikliği veya güvenlik olayı oluşana kadar oturum sürer.
- **İşaretsiz (varsayılan):** tarayıcı oturumu çerezi; tarayıcı kapanınca çerez silinir.
  Sunucuda en fazla 8 saat mutlak ömür ve 30 dakika hareketsizlik sınırı vardır.
- **Yönetici hesapları:** tercihten bağımsız en fazla 8 saat mutlak ve 15 dakika
  hareketsizlik; asla kalıcı oturum verilmez.
- Tercih tarayıcı deposuna yazılmaz; oturum kaydında tutulur. Denetim kaydına parola veya
  jeton yazılmaz.
- Telefon, tablet ve bilgisayar oturumları aynı anda açık kalabilir; hepsi aynı bulut
  portföyünü gösterir. Normal "Çıkış" yalnızca mevcut cihazı, Ayarlar'daki "Tüm
  cihazlardan çıkış yap" bütün cihazları kapatır.
- Güvenlik olayları oturumu zorunlu olarak kapatır: kullanıcının parola değişikliği
  (diğer cihazlar), yönetici parola sıfırlama / pasifleştirme / oturum iptali / hesap
  silme (bütün cihazlar).
- Oturum jetonu yalnızca `Secure` + `HttpOnly` + `SameSite=Lax` çerezde taşınır; parola,
  erişim jetonu veya dahili e-posta `localStorage` / `sessionStorage` / IndexedDB'ye
  yazılmaz. Bildirim/push veya başka bir cihaz izni istenmez.
- Yönetici, kullanıcının aktif oturumlarını cihaz etiketi ve tarihlerle görür ve
  kapatabilir; ham IP veya cihaz parmak izi saklanmaz.

## 4. Kullanıcı modeli

### 4.1 Kayıt ve giriş

- **Herkese açık kayıt ekranı yoktur.** "Kayıt Ol" bağlantısı bulunmaz.
- Kullanıcılar yalnızca yönetici tarafından oluşturulur.
- Giriş ekranında **yalnızca kullanıcı adı ve parola** alanı bulunur.
- E-posta, telefon, OTP, sihirli bağlantı ve sosyal giriş **kullanılmaz**.
- Giriş hatasında "kullanıcı bulunamadı" / "parola yanlış" ayrımı yapılmaz; tek genel mesaj gösterilir.
- Başarılı oturum sunucu tarafında yönetilen güvenli, kalıcı çerezle sürdürülür; kullanıcı
  yalnızca açıkça çıkış yaptığında veya bir güvenlik olayında oturumunu kaybeder (bkz. 3.1).
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

> Uygulama vergi, muhasebe veya yatırım danışmanlığı hizmeti değildir; kullanıcının
> girdiği verilere ve bilgilendirme amaçlı fiyatlara dayalı bir portföy takip aracıdır.
> Ayrıntılı model: [ACCOUNTING_MODEL.md](ACCOUNTING_MODEL.md).

### 6.1 Panel (dashboard)

İlk hesap **kesinlikle boş** başlar. Örnek varlık eklenmez; boş portföyde bütün değerler 0 TL'dir.

Kartlar: **Tahmini Bozdurma Değeri**, **Yeniden Alım Değeri**, **Elde Kalan Maliyet**,
**Gerçekleşmemiş K/Z**, **Gerçekleşmiş K/Z**, **Toplam K/Z**.

- Ana butonlar: **Mevcut Altını Ekle**, **Yeni Alış Ekle**, **Satış Ekle**.
- Her ürün satırında: mevcut miktar ve birim, ortalama takip maliyeti, maliyet kalite
  rozeti (Gerçek / Tahmini / Takip başlangıç değeri / Karışık), güncel bozdurma ve yeniden
  alım fiyatı, bozdurma ve yeniden alım değeri, gerçekleşmemiş K/Z.
- Portföyde tahmini veya takip başlangıç değerli kayıt varsa "Takip başlangıcından itibaren
  K/Z", bütün maliyetler gerçekse "Maliyet bazlı K/Z" ifadesi kullanılır. "Hayat boyu toplam
  kâr", "kesin kâr", "vergiye esas kâr" ifadeleri kullanılmaz.
- Fiyat yoksa, geçersizse, kullanılabilir değilse veya bayatsa değerleme hesaplanmış gibi
  gösterilmez; "Fiyat verisi kullanılamıyor" gösterilir.
- Fiyat kaynağı, piyasa, veri durumu ve son fiyat zamanı — panelin altında tek satırlık
  şeritte; "gerçek piyasa verisi değil" uyarısı her zaman görünür.

### 6.2 Altın ekleme akışları

**Mevcut altınımı ekliyorum (açılış bakiyesi)** — en fazla üç adım: ürün + miktar →
maliyet yöntemi → onay.

| Yöntem | Girdi | Etiket |
| --- | --- | --- |
| Gerçek maliyetimi biliyorum | ortalama birim maliyet veya toplam maliyet (diğeri hesaplanır) | Gerçek maliyet |
| Yaklaşık maliyetimi biliyorum | tahmini ortalama veya toplam | Tahmini maliyet (sürekli görünür) |
| Bugünden itibaren takip et (varsayılan) | yalnızca miktar; sunucu o anki bozdurma fiyatını alır | Takip başlangıç değeri |

Takip başlangıcı onay ekranında bozdurma fiyatı, yeniden alım fiyatı, sağlayıcı, piyasa,
fiyat zamanı ve başlangıç değeri gösterilir; "Bu değer gerçek tarihsel alış maliyetiniz
değildir. Kâr/zarar bu takip başlangıcından itibaren hesaplanacaktır." uyarısı yer alır.
Fiyat kullanılabilir değilse bu seçenek kullanılamaz. Fiyat anlık görüntüsü değiştirilemez
biçimde saklanır.

**Yeni alış işlemi:** ürün, miktar, tarih, fiyat giriş yöntemi (birim fiyat + masraflar **veya**
bütün masraflar dâhil toplam ödenen tutar), isteğe bağlı işçilik, isteğe bağlı komisyon, not.
Kullanıcının gerçek işlem fiyatı esastır; piyasa fiyatı yalnızca öneridir.

**Satış:** ürün, satılan miktar, tarih, birim satış fiyatı **veya** net tahsil edilen tutar,
satış masrafları, not. Satış miktarı hiçbir kronolojik anda eldeki miktarı aşamaz.

Doğrulama: miktar > 0 (gram üründe en fazla 6 ondalık, adet üründe pozitif tam sayı),
tutarlar sonlu ve pozitif, NaN / Infinity / bilimsel gösterim / aşırı büyük değer reddedilir,
tarih gelecekte olamaz.

### 6.3 İşlem geçmişi ve iptal / düzeltme

- Her kayıtta işlem türü, tarih, miktar, gerçek işlem fiyatı/tutarı, masraflar, maliyet
  türü ve durum (Aktif / İptal edildi / Düzeltildi) görünür.
- "Sil" kaydı **iptal eder** (VOID): sebep ve tarih kaydedilir, pozisyon yeniden hesaplanır,
  kayıt listede "İptal edildi" olarak kalır. "Düzenle" mevcut kaydı "Düzeltildi" yapar ve
  yerine yeni kayıt oluşturur; iki kayıt birbirine bağlıdır.
- Geçmiş bir kaydın iptali/düzeltilmesi sonraki bir satışı eldeki miktarın üstüne çıkarıyorsa
  işlem reddedilir.
- Çift tıklama veya mobil ağ yeniden denemesi aynı işlemi iki kez oluşturmaz (idempotency).

### 6.4 Ürün kataloğu

Gram Altın, Has Altın, 24 Ayar Külçe, Özel Gramajlı Külçe, 22 Ayar Bilezik, 18 Ayar Altın,
14 Ayar Altın, 8 Ayar Altın, Yeni/Eski Çeyrek, Yeni/Eski Yarım, Yeni/Eski Tam, Cumhuriyet Altını,
Ata Altın, Reşat Altın, Hamit Altın, İkibuçuk Altın, Beşli Altın, Gremse Altın.

Katalog tek merkezden yönetilir: `src/domain/catalog.ts`. Her ürün ayrı maliyet havuzudur.

### 6.5 Hesaplama

- Maliyet yöntemi: **ürün bazlı hareketli ağırlıklı ortalama**.
- Alış: `maliyet += miktar × birim fiyat + işçilik + komisyon` (veya toplam ödenen tutar);
  `ortalama = kalan maliyet / kalan miktar`.
- Satış: `çıkarılan maliyet = satılan miktar × satış öncesi ortalama`;
  `gerçekleşmiş K/Z += net tahsilat − çıkarılan maliyet`; ortalama değişmez; miktar sıfırlanınca
  kalan maliyet sıfırdır.
- Bozdurma değeri = kalan miktar × kuyumcunun alış fiyatı (`liquidationPrice`).
- Yeniden alım değeri = kalan miktar × kuyumcunun satış fiyatı (`replacementPrice`).
- Gerçekleşmemiş K/Z = bozdurma değeri − kalan maliyet; Toplam K/Z = gerçekleşmiş + gerçekleşmemiş.
- Satış geliri nakit varlık olarak portföy değerine eklenmez (nakit hesabı tutulmaz).
- Kesin sayısal hesap: `decimal.js` + PostgreSQL `numeric`; API'de ondalık dize; ara adım
  yuvarlaması yok (bkz. ACCOUNTING_MODEL.md bölüm 8).

## 7. Fiyat verisi

- Bu sürümde yalnızca `MockPriceProvider` kullanılır ve **Test Verisi** olarak etiketlenir.
- Her fiyat kaydı şu alanları taşır: `productId`, `liquidationPrice` (bozdurma), `replacementPrice` (yeniden alım), `currency`, `market`,
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
