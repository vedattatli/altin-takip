# Fiyat Kaynağı Durumu (özel pilot)

Bu belge **ölçülmüş** durumu anlatır. Tahmin, hedef veya niyet içermez. Bir satır
"çalışıyor" diyorsa, o satırın altında hangi koşumda ölçüldüğü yazılıdır.

Son ölçüm: `artifacts/sarraf-tv/headless/run-report.json` — 2026-09-03, 400 saniye,
Chromium 151.0.7922.34, headless, sonuç `PARTIAL_OK`.

Aynı modda daha önce yapılan bir koşum bazı noktalarda **farklı** sonuç verdi;
farklar bölüm 4'te olduğu gibi yazılıdır. Tek koşumu "kesin davranış" saymıyoruz.

---

## 1. Kaynakların tek bakışta durumu

| Kaynak | Kimlik | Lisans durumu | Pilotta kullanılıyor mu? |
| --- | --- | --- | --- |
| MARKET_BASELINE | `market-baseline` | `DEV_ONLY` | Evet — maliyet tabanı ve testler için. Gerçek piyasa verisi **değildir**. |
| Sarraf TV Kayseri (ekran) | `sarraf-tv-kayseri-screen` | `EXPERIMENTAL_PRIVATE` | Evet — yalnızca izin listesindeki kullanıcıda, yalnızca aşağıdaki ürünlerde. |
| Kapalıçarşı Önerilen (Anlık Altın) | `anlik-altin-kapalicarsi` | `EXPERIMENTAL_PRIVATE` | Evet — Gram Altın için. Bkz. `docs/ANLIK_ALTIN_DOGRULAMA.md`. |
| Türkiye geneli (Truncgil) | `truncgil-turkiye` | `EXPERIMENTAL_PRIVATE` | Evet — yalnız ilk iki kaynakta hiç bulunmayan ürünler için. |
| Sarraf Pro Kayseri | `sarraf-pro-kayseri` | `LICENSE_REQUIRED` | Hayır — sözleşme ve API anahtarı yok. |
| AltınAPI | `altinapi` | `LICENSE_REQUIRED` | Hayır. |
| HasFiyat | `hasfiyat` | `LICENSE_REQUIRED` | Hayır. |
| KAYSARDER referansı | `kaysarder-reference` | `REFERENCE_ONLY` | Hayır — değerlemede kullanılamaz, yalnızca karşılaştırma. |

Lisanssız kaynaklar veritabanı kısıtıyla kapalıdır
(`price_providers_enabled_requires_license`). Anahtar eklemek yetmez; lisans
durumu kod ve veritabanında ayrıca işaretlenmelidir.

### Hangi ürün hangi kaynaktan (hibrit plan)

Tek kaynak yerine ÜRÜN BAŞINA sabit kaynak kullanılır. Karar `src/prices/valuation-plan.ts`
içindedir ve `tests/valuation-plan.test.ts` ile sabitlenmiştir.

| Ürün | Kaynak | Gerekçe |
| --- | --- | --- |
| Gram Altın, Has Altın, 14 Ayar Altın | Kapalıçarşı — Anlık Altın | Kayseri ekranında bu ürünlerin iki yönlü satırı yok; HAS ve 14 AYAR tek fiyatlı |
| Çeyrek / Yarım / Tam (yeni ve eski) | Kayseri — Sarraf TV | Ekranda iki yönlü, yönetici onaylı kategori fiyatı |
| Ata Altın, Reşat Altın | Kayseri — Sarraf TV | "ATA - REŞAT LİRA" satırı iki ürünü açıkça sayar (GROUPED_EXPLICIT) |
| Beşli Altın | Kayseri — Sarraf TV | "ATA - REŞAT BEŞLİ" satırı, aynı gruplama |
| Gremse Altın | Kayseri — Sarraf TV | Ekranda iki yönlü satır |
| Cumhuriyet, Hamit, İkibuçuk, 18 Ayar | Türkiye geneli — Trunçgil | İlk iki kaynakta hiç yok |
| Külçe (24 ayar / özel), 22 Ayar Bilezik, 8 Ayar | **Yok** | Hiçbir kaynak iki yönlü fiyat yayımlamıyor; türetilmez |

Eski çeyrek / yarım / tam, aynı kategorinin fiyatıyla değerlenir: ekran yeni-eski
ayrımı yayımlamaz, tek kategori fiyatı verir (`SHARED_CATEGORY_QUOTE`). Fiyat
türetilmez veya ölçeklenmez; birebir aynı kayıt kullanılır.

Bir ürünün alış ve satış fiyatı **her zaman aynı kaydın iki alanıdır**. Planlanan
kaynak veri vermezse ürün fiyatsız kalır; başka kaynağın fiyatı o ürüne yazılmaz.

---

## 2. Sarraf TV Kayseri ekran kaynağı — ne ölçüldü

### Veri nereden geliyor

Ölçüm sonucu (Sprint 3.2, doğrudan gözlem):

- `interactive.sarraf.pro/price/list` yanıtı `title`, `buying`, `sales`, `updatedAt`
  alanlarını taşır. **Yön kanıtı** (hangi sütun alış, hangisi satış) buradan
  gelir. `updatedAt` alanı da görülebiliyor ama her koşumda yakalanamadığı için
  uygulama onu kullanmaz — gerekçesi bölüm 3'te.
- WebSocket akışında yalnızca genel piyasa kurları vardır; bayi fiyatları yoktur.
- Nihai bayi fiyatları **tarayıcıda hesaplanır**. Bu yüzden canlı değerin tek
  kanalı DOM'dur; ağ yanıtı yalnızca açılışta sözleşme/yön doğrulaması içindir.

Bunun doğrudan sonucu: bu kaynak bir REST API **değildir**. Kod içinde de öyle
adlandırılmaz — sağlayıcı türü `SCREEN`'dir (`src/prices/contract.ts`).

### Ürün eşleme güveni

| Güven | Anlamı | Değerlemeye girer mi? |
| --- | --- | --- |
| `NETWORK_VERIFIED` | Etiket birebir eşleşti **ve** alış/satış yönü ağ yanıtıyla doğrulandı | Evet |
| `GROUPED_EXPLICIT` | Ekran başlığı grubu ürünü tek anlamlı belirtiyor | Evet |
| `OPERATOR_VERIFIED` | Yönetici, kanıta bakarak elle onayladı | Evet |
| `EXACT` | Etiket eşleşti ama yön doğrulanmadı | **Hayır** |
| `CONVENTION` | Yeni/eski ayrımı ekranda yazmıyor, teamüle göre tahmin | **Hayır** |
| `UNRESOLVED` | Bilerek eşlenmedi | Hayır |

Kural kodda tek yerdedir: `VALUATION_READY_CONFIDENCE`
(`src/prices/providers/sarraf-tv-screen-mapping.ts`).

### Son koşumda gerçekte ne çözüldü

Ekranda 12 satır okundu. Bunların 4'ü ürüne bağlandı, 8'i **bilerek** çözülmedi.

| Ekran etiketi | Sonuç | Güven | Değerlemeye girer mi? |
| --- | --- | --- | --- |
| GREMSE | `gremse-altin` | `NETWORK_VERIFIED` | **Evet** |
| ÇEYREK | `yeni-ceyrek` | `CONVENTION` | Hayır — yönetici onayı gerekir |
| YARIM | `yeni-yarim` | `CONVENTION` | Hayır — yönetici onayı gerekir |
| TAM ALTIN | `yeni-tam` | `CONVENTION` | Hayır — yönetici onayı gerekir |

Yani **o koşumda tek bir ürün canlı fiyatla değerlenebiliyordu: Gremse Altın.**
Çeyrek, Yarım ve Tam için yöneticinin onay vermesi gerekiyordu; onaya kadar bu
ürünler "fiyat alınamıyor" uyarısı gösterir.

> **Koşumdan sonra ne değişti.** Yukarıdaki sayılar 2026-09-03 koşumunun kaydıdır
> ve öyle kalır — sonradan düzeltilmez. O koşumdan sonra iki şey oldu:
>
> 1. Çeyrek / Yarım / Tam eşlemeleri `price_mapping_approve` ile yönetici
>    tarafından onaylandı (`OPERATOR_VERIFIED`). Kanıt olarak uydurma değil, o an
>    ekranda okunan değerler kullanıldı; onaylayan yönetici ve zaman denetim
>    kaydındadır.
> 2. Eşleme sürümü 4'e çıktı: "ATA - REŞAT LİRA" ve "ATA - REŞAT BEŞLİ" satırları
>    `GROUPED_EXPLICIT` olarak eşlendi.
>
> Sürüm değişimi, önceki sürümde alınmış onayları **geçersiz kılar**
> (`SARRAF_TV_SCREEN_MAPPING_VERSION`). Onay bir kod işi değil, dağıtım başına
> yapılan operasyonel bir adımdır: her sürüm değişiminden sonra
> `npm run mappings:approve` ile yeniden verilir. Kodun depoda olması, onayın o
> ortamın veritabanında kayıtlı olduğu anlamına gelmez — hangi ürünün gerçekten
> değerlemeye girdiği `/yonetim/deneysel-kaynak` ekranından görülür.

### Bilerek çözülmeyen satırlar

Güncel eşlemede (sürüm 4) hiçbir ürüne bağlanmayan satırlar:

| Ekran etiketi | Neden |
| --- | --- |
| 24 AYAR PAKETLİ | Katalogdaki karşılığı belirsiz (paket ağırlığı yazılı değil) |
| KÜLÇE GÜMÜŞ | Altın değil |
| DOLAR / EURO / STERLİN | Altın değil |

"ATA - REŞAT LİRA" ve "ATA - REŞAT BEŞLİ" 3. sürüme kadar bu listedeydi; 4.
sürümde `GROUPED_EXPLICIT` oldular. Gerekçe ve ölçüm
`src/prices/providers/sarraf-tv-screen-mapping.ts` içinde yazılıdır.

Tek fiyatlı satırlar (HAS, 22 / 14 / 8 AYAR) bir ürüne bağlanır ama `EXACT`
kalır: fiyatın alış mı satış mı olduğu kanıtlanamadığı için değerlemeye
**girmez**. Bu ürünlerden değerlenenler Kayseri ekranından değil, plandaki
başka bir kaynaktan gelir.

Bunlar için fiyat **uydurulmaz**. Ekranda görünmeleri, uygulamada
kullanılabilecekleri anlamına gelmez.

---

## 3. Zaman damgası politikası

| Kaynak | `providerTimestamp` | `timestampProvenance` |
| --- | --- | --- |
| Lisanslı REST kaynakları | Yanıttaki alan | `UPSTREAM` |
| Sarraf TV ekran | `null` | `OBSERVED` |

Ekran kaynağı için "son fiyat zamanı" **bilinmez**; yalnızca "biz ne zaman
gördük" bilinir. Arayüz bunu "Son ekran gözlemi" olarak yazar; "Son fiyat"
demez (`src/components/price-source-line.tsx`).

`OBSERVED` gözlem 120 saniyeden eskiyse kalite kapısı `OBSERVATION_STALE` ile
reddeder. `UNKNOWN` köken hiçbir koşulda kabul edilmez
(`TIMESTAMP_PROVENANCE_UNKNOWN`).

### Kaynak zaman damgası neden kullanılmıyor

`interactive.sarraf.pro/price/list` yanıtı bir `updatedAt` alanı taşır ve bir
koşumda bu alan gözlendi (`providerTimestampProven: true`). Ancak son koşumda
aynı yanıt yakalanamadı (`providerTimestampProven: false`): yanıt sayfa
yüklenirken bir kez geliyor ve her koşumda kaydedilemiyor.

Yani kaynak zamanı **bazen** görülebiliyor, her zaman değil. Bu yüzden uygulama
onu hiç kullanmıyor: bir koşumda var olan, diğerinde olmayan bir alana
dayanarak "kaynak fiyat saati" göstermek, kullanıcıya güvenilirliği olmayan bir
kesinlik sunmak olurdu. Politika tek ve tutarlıdır — `OBSERVED`.

---

## 4. Ölçülen sınırlar

Bunlar başarısızlık değil, dürüst kayıttır:

- **Ekranın canlı tiklediği KANITLANDI.** 400 saniyelik koşumda 5 güncelleme
  gözlendi (`autoUpdates: 5`) ve iki anlık görüntü arasında gerçek fiyat
  hareketi ölçüldü (örn. yeni çeyrek bozdurma 11000 → 10950). Bu, daha önceki
  bir koşumda gözlenememişti; o koşumda ekran hareketsizdi (`autoUpdates: 0`).
  Dolayısıyla ekran canlıdır ama **her koşumda hareket görülmesi garanti
  değildir** — piyasa sakinken değer değişmez.
- **CAPTCHA scriptleri var.** İki bot koruma scripti yüklendi
  (`botProtectionScripts: 2`) ama **etkileşim istenmedi**
  (`captchaInteractionRequired: false`). Bu her zaman böyle olacak diye bir
  garanti yoktur. CAPTCHA çıkarsa worker fiyat üretmez ve durur — çözmeye
  çalışmaz.
- **Kısa koşumlar, tek makine.** En uzun ölçüm 400 saniyedir. Günler süren
  dayanıklılık ölçülmedi. Worker'ın kurtarma davranışı ayrıca container içinde
  sınandı (ağ kesikken 10 kurtarma döngüsü, üstel geri çekilme, açılış payı
  sonrası `/healthz` → 503) ama bu, gerçek pilotta günlerce sorunsuz çalışacağı
  anlamına gelmez.
- **Koşumlar birbirinin aynısı değil.** Aynı modda iki koşum farklı anlık
  görüntü sayısı, farklı ağ yakalama ve farklı hareket verdi. Rapor her koşumu
  ayrı yazar; ortalama alıp tek bir "doğru" üretmez.
- **Sayfa uzun koşumlarda Chromium'u çökertiyor.** Ölçülen: `closeError`
  alanında `Error: page.waitForTimeout: Page crashed`. Üç ardışık koşumda
  tekrarlandı ve `--disable-dev-shm-usage` eklendikten sonra da devam etti;
  yani paylaşımlı bellek tek neden değil. Sonucu:
  - `strict` mod bu ortamda **geçemez** (üç gözlem tamamlanamıyor). Bunu
    "geçti" diye raporlamıyoruz.
  - Worker bu durumdan artık kurtuluyor (aşağıya bakın), ama çökme her
    olduğunda açılış imzası yeniden öğrenilir ve o tur fiyat üretilmez.
  - Pilotta fiyatların arada bir 1–2 dakika gelmemesi **beklenen** davranıştır.

### Çökme kurtarması — ne ölçüldü

Çökme sessiz bir arızadır: Chromium çöken sayfayı **kapatmaz** ve tarayıcı
bağlantısı da **kopmaz**. Yalnızca `isClosed()` / `isConnected()` bakan bir
kontrol o sayfayı "canlı" sanır.

Dahası, çökmüş sayfada `evaluate` davranışı ortama göre değişiyor:

| Ortam | Chromium | Çökmüş sayfada `evaluate` |
| --- | --- | --- |
| Yerel (Windows) | 151.0.7922.34 | Hata atıyor (`Target crashed`) |
| Worker imajı (Linux) | 141.0.7390.37 | **Donuyor** (hata atmıyor) |

Bu yüzden kurtarma üç bağımsız işarete dayanır ve hiçbirine tek başına
güvenilmez: `page.on("crash")` olayı, `evaluate` hatasında çökme imzası
eşlemesi, ve her değerlendirmeye konulan zaman aşımı (donma da çökme sayılır).
Zaman aşımı olmasaydı worker ölü sayfada sonsuza kadar askıda kalırdı — bu,
döngüde kalmaktan daha kötüdür çünkü hiç log üretmez.

Doğrulama davranışsaldır, kaynak okumakla yetinilmedi: duman testi renderer'ı
CDP `Page.crash` ile bilerek çökertip oturumun ölü işaretlendiğini ve tarayıcı
bağlantısının hâlâ açık olduğunu ölçer.
- **Lisans yoktur.** Bu kaynak yeniden yayımlanamaz, paylaşılamaz, ticari
  ürüne konulamaz. `EXPERIMENTAL_PRIVATE` tam olarak bunu ifade eder ve
  veritabanı bu kaynağın genel listeye açılmasını kısıtla engeller.

---

## 5. Bir ürün desteklenmiyorsa ne olur

Uydurma fiyat üretilmez. Panelde o ürünün satırında şu yazar:

> Bu ürün için güvenilir Kayseri fiyatı alınamıyor; değerleme ve gerçekleşmemiş
> K/Z hesaplanmadı.

Alış maliyeti, ağırlık ve gerçekleşmiş K/Z görünmeye devam eder — bunlar fiyat
kaynağına bağlı değildir. Sadece güncel değer ve gerçekleşmemiş K/Z boş kalır.

---

## 6. Kaynak nasıl genişletilir (doğru yol)

1. Yönetici `/yonetim/deneysel-kaynak` ekranını açar.
2. `CONVENTION` güvenli satırın kanıtını görür: ham etiket, ekrandaki alış/satış
   ve gözlem zamanı.
3. Doğruysa onaylar. Onay `price_mapping_approvals` tablosuna
   `OPERATOR_VERIFIED` güveniyle yazılır ve kim/ne zaman onayladığı saklanır.
4. Onaydan sonra o ürün değerlemeye girer.

Onay geri alınabilir (`revoked_at`). Geri alınınca ürün tekrar uyarı gösterir;
başka bir kaynağın fiyatına **sessizce** düşülmez.
