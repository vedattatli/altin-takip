# Sarraf TV Kayseri — Teknik Fizibilite Raporu

> Bu rapor otomatik üretilir. Araç deneyseldir, üretim sağlayıcı mimarisinin
> parçası DEĞİLDİR ve kullanıcıya fiyat üretmez. CAPTCHA aşılmaz, bot koruması
> delinmez, hiçbir uç tarayıcı dışında çağrılmaz.

- **Tarayıcı modu:** `headless`
- **Başlangıç:** 2026-09-04T06:37:49.071Z
- **Bitiş:** 2026-09-04T06:48:06.634Z (618 sn)
- **Chromium:** 151.0.7922.34
- **Hedef:** `https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri`
- **Sonuç:** `PARTIAL_OK`
- **Açıklama:** 7 ürün okundu ve doğrulandı; 6 satır bilerek çözülmedi.

> Bu dosya SON çalıştırmanın modunu yansıtır. Her iki mod için ayrı ham
> artefaktlar `artifacts/sarraf-tv/headed/` ve `artifacts/sarraf-tv/headless/`
> altındadır; oradaki `run-report.json` dosyaları modu ayrı ayrı kanıtlar.

## Koşum bilgileri

| Alan | Değer |
| --- | --- |
| Chromium açıldı mı? | Evet |
| İlk fiyatın gelme süresi | 5346 ms |
| Ekran satırı | 12 |
| Çözülen satır | 7 |
| Çözülemeyen satır | 6 |
| Gizli/ölçülemeyen fiyat düğümü | 0 |
| Ekran imzası | `headers:buy,sell|rows:12|directional:8` |
| CAPTCHA script'i yüklendi mi? | Google reCAPTCHA, Google reCAPTCHA (kaynak) |
| Gerçek kullanıcı etkileşimi gerekti mi? | hayır |
| Kapanma nedeni | normal |
| Otomatik güncelleme (gözlem süresince) | 18 |

## Zaman damgası

Genel bir saat kalıbı (`12:30`) kaynak zamanı KANITI SAYILMAZ; sayfada saat
gösteren herhangi bir metin bu kalıba uyabilir.

| Soru | Yanıt |
| --- | --- |
| Sağlayıcının fiyat zamanı kanıtlandı mı? | Evet |
| Kanıt kaynağı | interactive.sarraf.pro/price/list → updatedAt |
| Örnek | 2026-09-04T06:37:54.157Z |
| Bizim gözlem zamanımız biliniyor mu? | Evet |
| Açılışta yön doğrulaması | 2026-09-04T06:38:02.034Z |
| Yönü doğrulanan başlıklar | ÇEYREK, YARIM, TAM ALTIN, GREMSE, ATA - REŞAT LİRA, ATA - REŞAT BEŞLİ |

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
| GROUPED_EXPLICIT | 3 | Evet |

## Okunan ürünler

### Gözlem 1 — 2026-09-04T06:38:02.035Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10950 | 11500 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21900 | 23000 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43800 | 46000 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 109500 | 115000 |
| ATA - REŞAT LİRA | ata-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47450 |
| ATA - REŞAT LİRA | resat-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47450 |
| ATA - REŞAT BEŞLİ | besli-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 225900 | 242450 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

### Gözlem 2 — 2026-09-04T06:43:04.005Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10950 | 11550 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21900 | 23100 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43800 | 46200 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 109500 | 115500 |
| ATA - REŞAT LİRA | ata-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47500 |
| ATA - REŞAT LİRA | resat-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47500 |
| ATA - REŞAT BEŞLİ | besli-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 226000 | 242550 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

### Gözlem 3 — 2026-09-04T06:48:05.979Z

| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |
| --- | --- | --- | --- | --- | --- | --- |
| ÇEYREK | yeni-ceyrek | CONVENTION | ALIŞ | SATIŞ | 10950 | 11500 |
| YARIM | yeni-yarim | CONVENTION | ALIŞ | SATIŞ | 21900 | 23000 |
| TAM ALTIN | yeni-tam | CONVENTION | ALIŞ | SATIŞ | 43800 | 46000 |
| GREMSE | gremse-altin | NETWORK_VERIFIED | ALIŞ | SATIŞ | 109500 | 115000 |
| ATA - REŞAT LİRA | ata-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47450 |
| ATA - REŞAT LİRA | resat-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 45250 | 47450 |
| ATA - REŞAT BEŞLİ | besli-altin | GROUPED_EXPLICIT | ALIŞ | SATIŞ | 225900 | 242400 |

Çözülemeyen satırlar (tahmin YAPILMADI):
- 24 AYAR PAKETLİ — KATALOGDA_KARŞILIĞI_BELİRSİZ
- KÜLÇE GÜMÜŞ — ALTIN_DEĞİL
- HAS — TEK_YÖNLÜ_REFERANS_FİYAT
- 22 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 14 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT
- 8 AYAR — TEK_YÖNLÜ_REFERANS_FİYAT

## Gözlem karşılaştırması

- Gözlem 1-2: 8 fark
- Gözlem 2-3: 8 fark

## Dayanıklılık (10 dk)

- Gözlenen güncelleme sayısı: 18
- Her sorguda yeni tarayıcı AÇILMADI; tek oturum açık tutuldu.

## Notlar

- (yok)

## Sınırlar

- Bu veri **resmî API değildir**; ekran ve doğal oturum gözlemidir.
- Genel ticari yayın için lisans konusu ayrıca çözülmelidir.
- Ekran yapısı değişirse okuma fail closed olur; yanlış fiyat üretilmez.
- Sayfa **Google reCAPTCHA, Google reCAPTCHA (kaynak)** yüklüyor. Bu koşumda etkileşim istenmedi ve hiçbir koruma aşılmadı; ancak skor tabanlı koruma, sunucu tarafı sürekli bir toplayıcıyı ileride engelleyebilir.
- **CONVENTION** eşlemeli satırlar (ÇEYREK / YARIM / TAM ALTIN) ekranda ve ağ yanıtında yeni/eski ayrımı bulunmadığı için piyasa teamülüne göre eşlendi ve yönetici onayı olmadan değerlemeye GİRMEZ.
