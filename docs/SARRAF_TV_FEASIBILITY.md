# Sarraf TV Kayseri — Teknik Fizibilite Raporu

> Bu rapor otomatik üretilir. Araç deneyseldir, üretim sağlayıcı mimarisinin
> parçası DEĞİLDİR ve kullanıcıya fiyat üretmez. CAPTCHA aşılmaz, bot koruması
> delinmez, hiçbir uç tarayıcı dışında çağrılmaz.

- **Tarayıcı modu:** `headless`
- **Başlangıç:** 2026-09-03T22:09:44.266Z
- **Bitiş:** 2026-09-03T22:20:01.183Z (617 sn)
- **Chromium:** 151.0.7922.34
- **Hedef:** `https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri`
- **Sonuç:** `PARTIAL_OK`
- **Açıklama:** 4 ürün okundu ve doğrulandı; 8 satır bilerek çözülmedi.

> Bu dosya SON çalıştırmanın modunu yansıtır. Her iki mod için ayrı ham
> artefaktlar `artifacts/sarraf-tv/headed/` ve `artifacts/sarraf-tv/headless/`
> altındadır; oradaki `run-report.json` dosyaları modu ayrı ayrı kanıtlar.

## Koşum bilgileri

| Alan | Değer |
| --- | --- |
| Chromium açıldı mı? | Evet |
| İlk fiyatın gelme süresi | 5500 ms |
| Ekran satırı | 12 |
| Çözülen satır | 4 |
| Çözülemeyen satır | 8 |
| Gizli/ölçülemeyen fiyat düğümü | 0 |
| Ekran imzası | `headers:buy,sell|rows:12|directional:8` |
| CAPTCHA script'i yüklendi mi? | Google reCAPTCHA, Google reCAPTCHA (kaynak) |
| Gerçek kullanıcı etkileşimi gerekti mi? | hayır |
| Kapanma nedeni | normal |
| Otomatik güncelleme (gözlem süresince) | 4 |

## Zaman damgası

Genel bir saat kalıbı (`12:30`) kaynak zamanı KANITI SAYILMAZ; sayfada saat
gösteren herhangi bir metin bu kalıba uyabilir.

| Soru | Yanıt |
| --- | --- |
| Sağlayıcının fiyat zamanı kanıtlandı mı? | Evet |
| Kanıt kaynağı | interactive.sarraf.pro/price/list → updatedAt |
| Örnek | 2026-09-03T22:09:48.783Z |
| Bizim gözlem zamanımız biliniyor mu? | Evet |
| Açılışta yön doğrulaması | 2026-09-03T22:09:57.234Z |
| Yönü doğrulanan başlıklar | ÇEYREK, YARIM, TAM ALTIN, GREMSE |

## Doğal tarayıcı oturumundaki fiyat sözleşmesi

| Soru | Yanıt |
| --- | --- |
| Fiyat tablosunu besleyen yanıt | interactive.sarraf.pro/price/list |
| Ürün başlığı var mı? | Evet (`title`) |
| Alış ve satış ayrı alanlarda mı? | Evet (`buying` / `sales`) |
| Yeni/eski ayrımı var mı? | Hayır |
| ATA ve Reşat ayrı mı? | Hayır (tek satırda birleşik) |
| Tek fiyatlı satırın yönü belli mi? | Hayır |
| Kaynak fiyat zamanı var mı? | Evet |
| Para birimi açıkça belirtiliyor mu? | Hayır |
| Ağdan okunan satır | 15 |

**Ağ ↔ DOM uyuşmazlığı:** 0

## Eşleme güveni

| Güven | Ürün sayısı | Değerlemeye girer mi? |
| --- | --- | --- |
| CONVENTION | 3 | Hayır (onay gerekir) |
| NETWORK_VERIFIED | 1 | Evet |

## Okunan ürünler

### Gözlem 1 — 2026-09-03T22:09:57.234Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 11000 | 11550 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 22000 | 23100 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 44000 | 46200 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 110000 | 115500 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

### Gözlem 2 — 2026-09-03T22:14:59.096Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 11000 | 11600 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 22000 | 23200 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 44000 | 46400 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 110000 | 116000 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

### Gözlem 3 — 2026-09-03T22:20:00.984Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 11000 | 11550 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 22000 | 23100 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 44000 | 46200 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 110000 | 115500 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- ATA - REŞAT LİRA — TEK_SATIRDA_İKİ_ÜRÜN
- ATA - REŞAT BEŞLİ — TEK_SATIRDA_İKİ_ÜRÜN
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

## Gözlem karşılaştırması

- Gözlem 1-2: 4 fark
- Gözlem 2-3: 4 fark

## Dayanıklılık (10 dk)

- Gözlenen güncelleme sayısı: 4
- Her sorguda yeni tarayıcı AÇILMADI; tek oturum açık tutuldu.

## Notlar

- (yok)

## Sınırlar

- Bu veri **resmî API değildir**; ekran ve doğal oturum gözlemidir.
- Genel ticari yayın için lisans konusu ayrıca çözülmelidir.
- Ekran yapısı değişirse okuma fail closed olur; yanlış fiyat üretilmez.
- Sayfa **Google reCAPTCHA, Google reCAPTCHA (kaynak)** yüklüyor. Bu koşumda etkileşim istenmedi ve hiçbir koruma aşılmadı; ancak skor tabanlı koruma, sunucu tarafı sürekli bir toplayıcıyı ileride engelleyebilir.
- **CONVENTION** eşlemeli satırlar (ÇEYREK / YARIM / TAM ALTIN) ekranda ve ağ yanıtında yeni/eski ayrımı bulunmadığı için piyasa teamülüne göre eşlendi ve yönetici onayı olmadan değerlemeye GİRMEZ.
