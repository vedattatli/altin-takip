# Sarraf TV Kayseri — Teknik Fizibilite Raporu

> Bu rapor otomatik üretilir (`npm run price:sarraf-feasibility`).
> Araç deneyseldir, üretim sağlayıcı mimarisinin parçası DEĞİLDİR ve
> kullanıcıya fiyat üretmez. CAPTCHA aşılmaz, bot koruması delinmez.

- **Çalıştırma zamanı:** 2026-09-03T09:27:13.233Z
- **Hedef:** `https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri`
- **Sonuç:** `OK`
- **Açıklama:** Ekran normal tarayıcı oturumunda okunabildi ve değerler birebir doğrulandı.

## Teknik kanal

| Soru | Yanıt |
| --- | --- |
| Fiyatlar DOM'da mı? | Evet (12 satır) |
| iframe içinde mi? | Hayır |
| XHR/fetch JSON yanıtı | 5 |
| WebSocket çerçevesi | 887 |
| Canvas tabanlı mı? | Hayır |
| Kaynak zaman damgası görünüyor mu? | Evet |
| Otomatik güncelleme (gözlem süresince) | 5 |
| Headless çalıştı mı? | denenmedi |
| CAPTCHA / etkileşim gerekti mi? | hayır |
| Sayfanın yüklediği bot koruması | Google reCAPTCHA, Google reCAPTCHA (kaynak) |

## Okunan ürünler

### Gözlem 1 — 2026-09-03T09:17:12.447Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10850 | 11450 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21700 | 22900 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43400 | 45800 |
| GREMSE | gremse-altin | EXACT | ALIŞ | SATIŞ | 108500 | 114500 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- HAS — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 22 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 14 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 8 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL

### Gözlem 2 — 2026-09-03T09:22:12.685Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10850 | 11450 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21700 | 22900 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43400 | 45800 |
| GREMSE | gremse-altin | EXACT | ALIŞ | SATIŞ | 108500 | 114500 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- HAS — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 22 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 14 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 8 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL

### Gözlem 3 — 2026-09-03T09:27:12.924Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10850 | 11400 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21700 | 22800 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43400 | 45600 |
| GREMSE | gremse-altin | EXACT | ALIŞ | SATIŞ | 108500 | 114000 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- HAS — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 22 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 14 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- 8 AYAR — ALIŞ_SATIŞ_BAŞLIĞI_YOK
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL

## Gözlem karşılaştırması

- Gözlem 1-2: 0 fark
- Gözlem 2-3: 4 fark

## Dayanıklılık (10 dk)

- Gözlenen güncelleme sayısı: 5
- Her sorguda yeni tarayıcı AÇILMADI; tek oturum açık tutuldu.

## Notlar

- (yok)

## Sınırlar

- Bu veri **resmî API değildir**; ekran gözlemidir.
- Sayfa **Google reCAPTCHA, Google reCAPTCHA (kaynak)** yüklüyor. Bu koşumda etkileşim istenmedi ve hiçbir koruma aşılmadı; ancak skor tabanlı koruma, sunucu tarafı sürekli bir toplayıcıyı ileride engelleyebilir. Kalıcı kullanım kararında bu risk hesaba katılmalıdır.
- Genel ticari yayın için lisans konusu ayrıca çözülmelidir.
- Ekran yapısı değişirse okuma fail closed olur; yanlış fiyat üretilmez.
- **CONVENTION** eşlemeli satırlar (ÇEYREK / YARIM / TAM ALTIN) ekranda yeni/eski ayrımı yazmadığı için piyasa teamülüne göre yeni ürüne eşlendi. Bu satırlar teyit alınmadan üretimde kullanılmaz.
- Tek fiyatlı satırlarda (HAS, 22/14/8 AYAR) alış mı satış mı olduğu ekranda YAZMIYOR; sıraya bakarak tahmin yapılmadı ve bu satırlar atlandı.
