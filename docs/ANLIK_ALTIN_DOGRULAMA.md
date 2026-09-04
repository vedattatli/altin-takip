# Anlık Altın Kayseri sayfası — teknik doğrulama

Bu belge `https://anlikaltinfiyatlari.com/altin/kayseri` sayfasının ölçüm
sonuçlarını kaydeder. Sonuçlar `valuation-plan.ts` içindeki ürün→kaynak
kararlarının gerekçesidir.

Ölçüm tarihi: **4 Eylül 2026**
Sonda: `npm run price:anlik:compare` → `tools/experimental/anlik-altin/compare-result.json`

---

## 1. Sayfa düz sunucu isteğiyle okunabiliyor mu?

**Evet.** Playwright gerekmiyor.

| Ölçüm | Sonuç |
| --- | --- |
| HTTP durumu | 200 |
| Gövde | 41 262 bayt |
| Ürün adları ham HTML'de | Var |
| Alış / satış ham HTML'de | Var (`data-name="<KOD>_alis|satis"`) |
| Güncelleme zamanı ham HTML'de | Var (satır başına `HH:MM:SS` + blok altında tarih) |
| JavaScript çalıştırma gereği | Yok |

---

## 2. Sayfada kaç tablo var, hangisi hangi kaynağa ait?

Sayfada **üç** blok vardır. Sekme çubuğunda yalnız ikisi görünür.

| Blok | `data-type` | Tablo | Sekme adı | İçerik |
| --- | --- | --- | --- | --- |
| `data-market="3"` | `kuyumcu` | `altinkaynak` | *(gizli, `class="hide"`)* | Altınkaynak toptan fiyatları |
| `data-market="5"` | **`harem`** | **`kapalicarsi_h`** | KAPALIÇARŞI ÖNERİLEN | Geniş fiyat tablosu |
| `data-market="4"` | `KAYSARDER: Kayseri Sarraflar` | *(yok)* | KAYSARDER | **Yalnızca iframe** |

### KAYSARDER bölümü

Bloğun **tamamı 257 bayttır** ve içinde **tek bir fiyat hücresi yoktur**:

```html
<div data-market="4" data-type="KAYSARDER: Kayseri Sarraflar">
  <iframe src="https://tv.sarraf.pro/?mode=frame&slug=kayseri&code=383838"
          width="100%" height="630" frameborder="0" scrolling="no" allowfullscreen>
  </iframe>
</div>
```

Yani bu sayfadaki "KAYSARDER" sekmesi, **Sarraf TV ekranının kendisidir** —
sayfanın kendi ürettiği bir veri değildir. Buradan fiyat okumak, doğrudan
`tv.sarraf.pro` ekranını okumakla aynı şeydir ve hiçbir sadeleşme sağlamaz.

### Geniş tablo kime ait?

Sayfanın adresi `/altin/kayseri` olsa da geniş tablonun kendi işaretleri
şunu söyler:

- `data-type="harem"` → besleme **Harem Altın**
- `id="kapalicarsi_h"`, `title="Kapalı Çarşı Altın"`
- sekme adı **"KAPALIÇARŞI ÖNERİLEN"**

Bu tablo **Kayseri tezgâh fiyatı değildir**; Kapalıçarşı referansıdır ve
uygulamada öyle etiketlenir.

---

## 3. Aynı-an karşılaştırması (üç gözlem)

Her gözlemde Anlık Altın sayfası ve `tv.sarraf.pro` ekranı **aynı anda**
okundu.

| Gözlem | Zaman (UTC) | Sarraf TV imzası |
| --- | --- | --- |
| 1 | 04:20:39 | `headers:buy,sell\|rows:12\|directional:8` (ekran henüz dolmamıştı) |
| 2 | 04:21:05 | `headers:buy,sell\|rows:12\|directional:8` |
| 3 | 04:21:28 | `headers:buy,sell\|rows:12\|directional:8` |

Gözlem 2 ve 3'teki değerler (TL):

| Ürün | Anlık Altın (Kapalıçarşı) | Sarraf TV (Kayseri) | Alış farkı | Satış farkı |
| --- | --- | --- | --- | --- |
| ÇEYREK | 11 212 / 11 358 | 11 000 / 11 550 | −212 | +192 |
| YARIM | 22 452 / 22 688 | 22 000 / 23 100 | −452 | +412 |
| TAM ALTIN | 44 697 / 45 223 | 44 000 / 46 200 | −697 | +977 |
| GREMSE | 111 226 / 112 675 | 110 000 / 115 500 | −1 226 | +2 825 |

**Karşılaştırılan hücre: 24. Birebir eşleşen: 0. Uyuşmayan: 24.**

Farkın yönü tutarlıdır ve piyasa mantığına uyar: yerel sarraf **daha ucuza
alır, daha pahalıya satar** (geniş makas); Kapalıçarşı referansının makası
dardır. İki kaynak **farklı piyasalardır**.

### Sonuç

Talimattaki **A şıkkı geçerli değildir**: değerler birebir aynı olmadığı gibi,
Anlık Altın sayfasında karşılaştırılacak bir KAYSARDER tablosu da yoktur.
**B şıkkı uygulanır.**

---

## 4. Altı ürünün nihai kaynağı

| Ürün | Kaynak | Neden |
| --- | --- | --- |
| Gram Altın | Kapalıçarşı — Anlık Altın | Kayseri ekranında gram altının **iki yönlü** satırı yok; yalnız tek fiyatlı "HAS" ve "22 AYAR" var |
| Çeyrek Altın | Kayseri — Sarraf TV | Ekranda iki yönlü, yönü doğrulanmış satır |
| Yarım Altın | Kayseri — Sarraf TV | Aynı |
| Tam Altın | Kayseri — Sarraf TV | Aynı |
| Ata Altın | Kayseri — Sarraf TV | "ATA - REŞAT LİRA" satırı, kaynağın **açıkça** grupladığı iki ürünü adıyla sayar |
| Gremse Altın | Kayseri — Sarraf TV | Ekranda iki yönlü satır |

Beş ürün Kayseri yerel fiyatından, bir ürün Kapalıçarşı referansından değerlenir.
Türkiye geneli akışı (Trunçgil) yalnızca ilk iki kaynakta hiç bulunmayan
ürünler için kullanılır (Cumhuriyet, Hamit, İkibuçuk, 18 Ayar).

Bir ürünün alış ve satış fiyatı **her zaman aynı kaydın iki alanıdır**;
kaynak karıştırma yapısal olarak imkânsızdır (`tests/valuation-plan.test.ts`).

---

## 5. Playwright hâlâ gerekli mi?

**Evet — yalnız Sarraf TV için.**

`tv.sarraf.pro` sayfasının ham HTML'i 1 031 bayttır ve içinde tek bir ürün
adı veya fiyat yoktur; sayfa bir JavaScript uygulamasıdır ve bayi fiyatını
tarayıcıda hesaplar. Kapalıçarşı ve Türkiye geneli kaynakları ise düz istekle
okunur.

Bu yüzden bulut toplayıcısı **tek iş** içinde iki yol izler: önce tarayıcısız
HTTP kaynakları, sonra Chromium ile ekran.

---

## 6. Sayı biçimi — ölçülerek belirlendi

Kaynak noktayı **ondalık ayırıcı** olarak kullanır (`6875.51`) ve binlik
ayırıcı hiç kullanmaz (`44704`, `111242`).

Türkçe biçim varsayılsaydı gram altın **687 551 TL** görünürdü — yüz katı bir
hata. Bu yüzden biçim tek bir değere değil tablonun tamamına bakılarak
belirlenir (`src/prices/number-format.ts`); kalıplar çelişirse hiçbir sayı
okunmaz.

---

## 7. Zaman damgası

Kaynak her satırın kendi saatini (`07:13:57`) ve blok altında tarihi
(`04 Eylül 2026`) yayımlar; damga taşınır. Ancak **saat dilimi yazmaz**;
`+03:00` varsayımı bizimdir. Bu yüzden damganın kökeni `OBSERVED` olarak
işaretlenir ve arayüzde sağlayıcının kesin damgası gibi sunulmaz.
