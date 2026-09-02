# Muhasebe Modeli

> Bu uygulama vergi, muhasebe veya yatırım danışmanlığı hizmeti **değildir**.
> Kullanıcının girdiği verilere ve bilgilendirme amaçlı (bu sürümde **test**)
> fiyatlara dayalı bir portföy takip aracıdır. "Hayat boyu toplam kâr", "kesin kâr"
> veya "vergiye esas kâr" gibi ifadeler kullanılmaz.

## 1. Yöntem: ürün bazlı hareketli ağırlıklı ortalama maliyet

Her altın ürünü (Gram Altın, Has Altın, Yeni Çeyrek, Eski Çeyrek, Yarım, Tam,
Cumhuriyet, Ata, Reşat, Gremse, 22 Ayar Bilezik, …) **ayrı bir maliyet
havuzudur**. Ürünlerin miktarı veya ortalama maliyeti birbirine karıştırılmaz;
yalnızca TL cinsinden değerler portföy düzeyinde toplanır.

İşlem türleri: `OPENING_BALANCE` (mevcut altın / açılış bakiyesi), `BUY`, `SELL`.
Tasarım `TRANSFER_IN`, `TRANSFER_OUT`, `ADJUSTMENT` eklenebilecek biçimde
genişletilebilir; bu sprintte eklenmemiştir. FIFO, XIRR, TWR veya vergi
muhasebesi kapsam dışıdır.

## 2. Kaynak gerçek: işlem defteri

Toplam miktar ve maliyet elle düzenlenebilir bir hücrede saklanmaz. Kaynak
gerçek **append-only işlem defteri**dir (`public.transactions`):

- Kayıtlar değiştirilmez; yalnızca durumu `ACTIVE → VOID` ("Sil") veya
  `ACTIVE → REPLACED` ("Düzenle") olur. Hard delete yoktur (hesap silme cascade'i hariç).
- "Düzenle": mevcut kayıt `REPLACED` olur, yerine yeni kayıt eklenir; iki kayıt
  `replaces_transaction_id` / `replaced_by_transaction_id` ile birbirine bağlanır;
  tümü **tek veritabanı işlemi** içinde.
- Deterministik sıra: `occurred_at` (tarih + isteğe bağlı saat, Europe/Istanbul → UTC an),
  `created_at`, `ledger_sequence`, `id` (bkz. bölüm 11).
- Geçmiş tarihli kayıt eklenince, iptal edilince veya düzeltilince ürünün
  pozisyonu defterden **yeniden oynatılır**.
- Geçmişteki bir değişiklik sonraki bir satışı eldeki miktarın üstüne çıkarıyorsa
  işlemin tamamı reddedilir; defter değişmez.

Türetilmiş projeksiyon `public.portfolio_positions` yalnızca performans içindir;
elle düzenlenemez (service_role'e bile yalnızca SELECT verilir) ve
`npm run accounting:verify` ile defterden yeniden hesaplanıp karşılaştırılır.

**Veritabanı sınırı (0011):** `service_role` (BFF) `public.transactions` ve
`public.price_snapshots` tablolarına da DOĞRUDAN yazamaz (yalnızca SELECT). Bütün
finansal mutation'lar SECURITY DEFINER `ledger_append` / `ledger_void` /
`ledger_replace` / `ledger_void_all` RPC'lerinden geçmek zorundadır; yanlışlıkla
yazılan bir `transactions.insert()` veritabanı tarafından reddedilir.

## 3. Açılış bakiyesi (mevcut altın) ve maliyet kökeni

Kullanıcı geçmişten kalan altınını üç yöntemden biriyle ekler:

| Yöntem | Girdi | `cost_basis_origin` | Etiket |
| --- | --- | --- | --- |
| Gerçek maliyeti biliyorum | ortalama birim maliyet **veya** toplam maliyet (diğeri hesaplanır) | `ACTUAL` | Gerçek maliyet |
| Yaklaşık maliyeti biliyorum | tahmini ortalama veya toplam | `ESTIMATED` | Tahmini maliyet (sürekli görünür) |
| Bugünden itibaren takip et (**varsayılan/önerilen**) | yalnızca miktar | `MARKET_BASELINE` | Takip başlangıç değeri |

`MARKET_BASELINE`:

- Sunucu, **kendi** fiyat sağlayıcısından (bu sürümde MockPriceProvider) ürünün o
  andaki **bozdurma (kuyumcu alış)** fiyatını alır. İstemciden gelen fiyat
  **kabul edilmez**.
- Fiyat yoksa, geçersizse, `status` "ok" değilse veya bayatsa açılış bakiyesi
  **oluşturulmaz** (`409 price_unavailable`).
- Başlangıç maliyet bazı = miktar × bozdurma fiyatı; açılış anında gerçekleşmemiş
  K/Z tam olarak **0**'dır.
- Fiyat anlık görüntüsü `public.price_snapshots` tablosuna **değiştirilemez** biçimde
  (UPDATE/DELETE tetikleyiciyle reddedilir) yazılır ve sonraki canlı fiyat
  yenilemelerinde değişmez. İçerik: `product_id`, `liquidation_price`,
  `replacement_price`, `provider`, `market`, `currency`, `provider_status`,
  `is_real_market_data`, `provider_timestamp`, `fetched_at`, `created_at`.
- Arayüz uyarısı: "Bu değer gerçek tarihsel alış maliyetiniz değildir. Kâr/zarar bu
  takip başlangıcından itibaren hesaplanacaktır."

Maliyeti tamamen bilinmeyen (referanssız) pozisyon modeli yoktur; maliyet
bilinmiyorsa `MARKET_BASELINE` kullanılır. Böylece satışta belirsiz maliyetin
nasıl dağıtılacağına dair uydurma bir politika oluşmaz.

## 4. Alış formülleri

Kullanıcının **gerçek** işlem fiyatı esastır; piyasa fiyatı yalnızca öneridir ve
maliyeti sonradan değiştirmez. Alanlar: `acquisition_unit_price` (kullanıcının
ödediği birim fiyat), `disposal_unit_price` (kullanıcının aldığı birim fiyat) —
piyasa alanları `liquidationPrice` / `replacementPrice` ile karıştırılmaz.

İki fiyat giriş yöntemi:

```
A. Birim fiyat + masraflar (UNIT_PRICE)
   gross           = quantity × acquisition_unit_price
   acquisition_cost = gross + workmanship + fees

B. Toplam ödenen tutar (TOTAL_AMOUNT)
   acquisition_cost = total_paid          (bütün masraflar DÂHİL, gerçekten ödenen)
   gross            = total_paid − workmanship − fees   (yalnızca bilgi amaçlı ayrıştırma)
```

Toplam tutar modunda işçilik/komisyon alanları toplamın **içindedir**; aynı masraf
ikinci kez maliyete eklenmez.

```
new_quantity             = old_quantity + purchased_quantity
new_remaining_cost_basis = old_remaining_cost_basis + acquisition_cost
new_average_cost         = new_remaining_cost_basis / new_quantity
```

## 5. Satış formülleri

```
A. Birim satış fiyatı (UNIT_PRICE)
   gross_proceeds = quantity × disposal_unit_price
   net_proceeds   = gross_proceeds − selling_fees

B. Net tahsil edilen tutar (TOTAL_AMOUNT)
   net_proceeds   = kullanıcının girdiği net tutar
   gross_proceeds = net_proceeds + selling_fees   (bilgi amaçlı)

removed_cost_basis      = quantity_sold × average_cost_before_sale
                          (uygulama: remaining_cost_basis × quantity_sold / quantity_before,
                           8 ondalığa HALF_UP; tamamı satılırsa kalan maliyetin tamamı)
realized_pnl           += net_proceeds − removed_cost_basis
remaining_quantity      = old_quantity − quantity_sold
remaining_cost_basis    = old_remaining_cost_basis − removed_cost_basis
average_cost_after_sale = average_cost_before_sale     (satış ortalamayı DEĞİŞTİRMEZ)
```

Kalan miktar tam sıfır olduğunda `remaining_quantity = 0`,
`remaining_cost_basis = 0`, `average_cost = null` (tek ve belgelenmiş davranış);
ondalık artık bırakılmaz. Satış miktarı hiçbir kronolojik anda eldeki miktarı aşamaz.

## 6. Güncel değerleme

| Alan | Anlam | Kullanım |
| --- | --- | --- |
| `liquidationPrice` (dealerBuyPrice) | Kuyumcunun kullanıcıdan altını **aldığı** fiyat | Bozdurma değeri, gerçekleşmemiş K/Z |
| `replacementPrice` (dealerSellPrice) | Kuyumcunun kullanıcıya altını **sattığı** fiyat | Yeniden alım değeri |

```
liquidation_value = remaining_quantity × current_liquidation_price
replacement_value = remaining_quantity × current_replacement_price
unrealized_pnl    = liquidation_value − remaining_cost_basis
total_pnl         = realized_pnl + unrealized_pnl
```

- Portföyün güncel değeri **yalnızca elde kalan altınları** kapsar. Gerçekleşmiş
  satış geliri nakit varlık olarak eklenmez (nakit hesabı tutulmaz); gerçekleşmiş
  K/Z ayrı metriktir.
- Fiyat yoksa, geçersizse, `status` kullanılabilir değilse veya bayatsa (mock için
  5 dakika) güncel değer ve gerçekleşmemiş K/Z **hesaplanmış gibi gösterilmez**;
  "Fiyat verisi kullanılamıyor" gösterilir. Başka ürünün fiyatından veya gram
  dönüşümünden sessiz tahmin yapılmaz.

## 7. Maliyet kalitesi etiketleri

| Pozisyon | Etiket |
| --- | --- |
| Yalnızca `ACTUAL` | Gerçek maliyet |
| Yalnızca `ESTIMATED` | Tahmini maliyet |
| Yalnızca `MARKET_BASELINE` | Takip başlangıç değeri |
| Birden fazla köken (örn. baseline + sonraki gerçek alış) | Karışık maliyet — "Gerçek geçmiş maliyet ile takip başlangıç değerinin birleşimi" |

Portföyde herhangi bir `ESTIMATED` veya `MARKET_BASELINE` kayıt varsa panelde
**"Takip başlangıcından itibaren K/Z"**, bütün maliyetler `ACTUAL` ise
**"Maliyet bazlı K/Z"** ifadesi kullanılır.

## 8. Kesin sayısal hesaplama ve yuvarlama politikası

- Finansal hesaplarda JavaScript `number` (ikili kayan nokta) **kullanılmaz**.
- PostgreSQL: `numeric` (miktar `numeric(18,6)`/`(20,6)`, tutarlar `numeric(20,8)`).
- API: bütün miktar ve para değerleri **ondalık dize** ("5009.52380952"). JSON parse
  sonrasında `Number`'a çevrilmez; Postgres `ledger_num_text` ile kanonik metin üretir.
- TypeScript motoru: `decimal.js` (precision 40, HALF_UP, bilimsel gösterim kapalı).
- Girdi: gram miktarında en fazla **6 ondalık**; adet ürününde yalnızca **pozitif tam
  sayı**; tutarlarda en fazla 4 ondalık girişi; NaN, Infinity, bilimsel gösterim
  (`1e5`), onaltılık, çoklu ayırıcı ve 12 tam sayı basamağını aşan değerler reddedilir.
- **Ara adım yuvarlaması yoktur.** Yalnızca deftere yazılırken:
  - `removed_cost_basis` → 8 ondalık HALF_UP (ortalama sonsuz ondalıklıysa),
  - `average_cost` ve bilgi amaçlı `acquisition_unit_price` / `disposal_unit_price` → 8 ondalık HALF_UP.
- Arayüz TL'yi 2 ondalıkla gösterir; bu yalnızca biçimlendirmedir ve önce decimal
  ile yuvarlanır. `0,1 + 0,2 = 0,30000000000000004` benzeri değer hiçbir API veya
  ekranda görünmez (`tests/accounting.test.ts` → ÖRNEK 10).
- Postgres ve TypeScript motoru aynı kuralları uygular; `npm run accounting:verify`
  ikisini karşılaştırır.

## 9. Atomiklik, eşzamanlılık ve idempotency

Her mutation (`ledger_append`, `ledger_void`, `ledger_replace`, `ledger_void_all`)
SECURITY DEFINER RPC'dir ve yalnızca BFF (`service_role`) çağırır:

1. Kullanıcının portföy satırı `FOR UPDATE` ile kilitlenir; ürün düzeyinde
   `pg_advisory_xact_lock` alınır.
2. Yetkili actor BFF'de doğrulanmıştır; RPC kullanıcı kapsamında çalışır.
3. Defter kaydı eklenir / durumu değişir.
4. Pozisyon defterden yeniden oynatılarak atomik güncellenir.
5. Herhangi bir anda negatif miktar → `ALTIN_OVERSELL` (P0001), işlem geri alınır.

Aynı anda iki cihazdan gönderilen iki 7 gramlık satış 10 gramı aşamaz; yalnızca
biri başarılı olur (`tests/integrity.test.ts`, yerel arka uç; Postgres'te satır
kilidi aynı garantiyi verir).

**Idempotency:** her mutation isteğe bağlı `clientRequestId` taşır;
`(user_id, client_request_id)` benzersizdir. Aynı anahtar + aynı içerik →
mevcut sonuç döner (`replayed: true`, HTTP 200). Aynı anahtar + farklı içerik →
`409 idempotency_conflict`. Formlar anahtarı bileşen ömrü boyunca sabit tutar;
çift tıklama veya mobil ağ yeniden denemesi aynı işlemi iki kez oluşturmaz.

## 10. Örnek hesaplar (kabul testleri)

| Örnek | Girdi | Sonuç |
| --- | --- | --- |
| 1 — ağırlıklı ortalama | 5 g × 3.500, 5 g × 4.200, 5 g × 3.700 | 15 g, 57.000 TL, ort. 3.800; bozdurma 4.100 → 61.500 TL, K/Z +4.500 |
| 2 — baseline + alış | açılış 100 g @ bozdurma 5.000 (500.000, K/Z 0); 5 g × 5.200 | 105 g, 526.000 TL, ort. 5.009,52380952…; bozdurma 5.300 → 556.500, K/Z 30.500; **Karışık maliyet** |
| 3 — çeyrek | 10 × 11.000, 2 × 11.200, 1 × 10.900, 1 × 11.300 | 14 adet, 154.600 TL, ort. 11.042,85714286; bozdurma 11.300 → 158.200, K/Z 3.600 |
| 4 — satış | 15 g / 57.000 / 3.800; 4 g × 4.200 satış | net 16.800, çıkarılan 15.200, gerçekleşmiş 1.600; kalan 11 g / 41.800 / ort. 3.800; bozdurma 4.100 → gerçekleşmemiş 3.300, toplam 4.900 |
| 5 — masraflar | 10 g × 5.000 + işçilik 500 + komisyon 100 | maliyet 50.600, ort. 5.060 |
| 6 — toplam ödenen | 10 g, toplam 51.200 | maliyet 51.200, ort. 5.120; işçilik ikinci kez eklenmez |
| 7 — eşzamanlı satış | 10 g varken aynı anda iki 7 g satış | yalnızca biri başarılı; negatif yok |
| 8 — idempotency | aynı `clientRequestId` ile aynı BUY iki kez | tek işlem; ikinci yanıt replay; farklı içerik → conflict |
| 9 — geçmiş tarihli değişiklik | sonraki satışı aşırıya düşüren alış iptali | reddedilir, defter değişmez |
| 10 — decimal | 0,1 g + 0,2 g | 0,3 g; kayan nokta artığı yok |

Bu örnekler `tests/accounting.test.ts`, `tests/integrity.test.ts`,
`supabase/tests/rls.test.sql` (Postgres motoru) ve `e2e/portfolio.spec.ts` içinde
doğrulanır.

## 11. İşlem zamanı ve aynı gün sıralaması

- Kullanıcı tarihi `YYYY-MM-DD`, isteğe bağlı saati `HH:MM` girer. Saat girmek zorunlu değildir.
- Bütün girdiler **Europe/Istanbul** yerel saatidir (varsayılan kullanıcı saat dilimi).
  Türkiye 2016'dan beri sabit UTC+03:00 kullanır; daha eski tarihlerde tarihsel yaz saati
  kuralları IANA tzdata ile (TypeScript'te `Intl`, Postgres'te `at time zone`) uygulanır.
- Tarih **gerçek bir takvim günü** olmalıdır: `2026-02-30` reddedilir, `2028-02-29` (artık yıl)
  kabul edilir. Gelecek tarih ve gelecek saat (5 dakika tolerans) reddedilir. Bu doğrulama
  istemcide, sunucuda ve `ledger_append` içinde (P0004) yapılır; veritabanı hatası genel
  500'e dönüşmez.
- Saklama: `traded_at` (tarih), `occurred_time` (saat, null olabilir) ve
  `occurred_at timestamptz` = `(tarih + (saat ?? 00:00)) at time zone 'Europe/Istanbul'`.
  Saat girilmeyen kayıt **o günün başlangıcı** sayılır; aynı gün içinde sıra gerekiyorsa her
  iki kayda da saat girilir.
- Yeniden oynatma sırası: `occurred_at`, `created_at`, `ledger_sequence`, `id`.
  Aynı gün 10:00 alış + 11:00 satış geçer; 11:00 alış + 10:00 satış olarak girilirse satış
  kronolojik olarak alıştan önce oynatılır ve `ALTIN_OVERSELL` ile reddedilir. Bir kaydın
  tarih/saat düzeltmesi aşırı satış oluşturuyorsa düzeltme reddedilir.
- Eski (yalnızca tarihli) kayıtlar migration ile deterministik biçimde
  `traded_at 00:00 Europe/Istanbul` anına taşınmıştır; sıraları değişmemiştir.

## 12. Maliyet kökeni: elde kalan pozisyon ↔ gerçekleşmiş K/Z

İki ayrı bayrak kümesi tutulur (`portfolio_positions` ve `positions_list`):

| Küme | Alan | Anlamı |
| --- | --- | --- |
| `holdingCostOrigins` (`has_actual/estimated/baseline`) | Elde kalan miktarın kökenleri | Alışta ilgili bayrak açılır; **kalan miktar tam sıfıra inince sıfırlanır** |
| `realizedPnlOrigins` (`realized_has_*`) | Gerçekleşmiş K/Z'nin tarihsel kökenleri | Satışta havuzun o andaki kökenleri kopyalanır; **hiç silinmez** |

Sonuçlar:

- 10 g `MARKET_BASELINE` ile açılır, tamamı satılır, 5 g gerçek fiyatla alınırsa elde kalan
  5 g "Gerçek maliyet" etiketlenir (Karışık değil); gerçekleşmiş K/Z kökeninde
  `MARKET_BASELINE` korunur.
- Portföy düzeyindeki "Takip başlangıcından itibaren K/Z" etiketi, açık pozisyonlarda **veya**
  geçmiş gerçekleşmiş K/Z'de `ESTIMATED` / `MARKET_BASELINE` varsa gösterilmeye devam eder;
  uygulama gerçek tarihsel maliyet iddiasında bulunmaz.
- Tamamen kapanmış ve yeniden açılmamış pozisyon: miktar 0, kalan maliyet 0, ortalama null,
  holding bayrakları false, realized bayrakları korunur.

## 13. Girilen fiyat ≠ efektif birim maliyet

| Alan | Alış | Satış |
| --- | --- | --- |
| Girilen (quoted) | `quotedAcquisitionUnitPrice`: UNIT_PRICE modunda kullanıcının girdiği birim fiyat (masraf HARİÇ); TOTAL_AMOUNT'ta **null (uydurulmaz)**; MARKET_BASELINE'da anlık görüntünün bozdurma fiyatı | `quotedDisposalUnitPrice`: girilen brüt birim satış fiyatı; TOTAL_AMOUNT'ta null |
| Efektif (türetilmiş) | `effectiveAcquisitionUnitCost = total_paid / quantity` (işçilik + masraf dâhil) | `effectiveNetUnitProceeds = net_proceeds / quantity` |

Örnek: 10 g × 5.000 TL + 500 TL işçilik + 100 TL masraf → girilen 5.000, brüt 50.000,
toplam 50.600, efektif 5.060; pozisyon ortalaması 5.060. Ortalama maliyet her zaman
`total_paid`, gerçekleşmiş K/Z her zaman `net_proceeds` üzerinden hesaplanır. Arayüzde
"birim alış fiyatı" adı altında efektif maliyet gösterilmez; işlem geçmişi ikisini ayrı
etiketler. Eski UNIT_PRICE kayıtlarında girilen fiyat `gross_amount / quantity` ile geriye
dönük oluşturulmuş, eski TOTAL_AMOUNT kayıtlarında null bırakılmıştır (0011). Veritabanında
efektif değerler `generated always as ... stored` sütunlardır; elle tutarsız hâle getirilemez.

## 14. Fiyat anlık görüntüsü doğrulaması ve kısmi değerleme

`MARKET_BASELINE` anlık görüntüsü (sunucudan gelse bile) hem TypeScript
(`validatePriceSnapshotInput`) hem `ledger_append` içinde denetlenir:
`liquidation_price > 0`, `replacement_price > 0`, `replacement_price >= liquidation_price`,
`currency = TRY`, ürün eşleşmesi, `provider_status = ok`, sağlayıcı/piyasa boş değil, geçerli
zaman damgaları, gelecekte en fazla 5 dakika, en fazla 15 dakika eski. Tablo kısıtları
(`price_snapshots_spread_consistent`, `price_snapshots_currency_try`) aynı kuralı sahip
bağlamında bile uygular. `isSnapshotStale` geçersiz, fazla eski ve toleransı aşan gelecek
zaman için `true` döner. Başka ürün veya piyasadan sessiz ikame yapılmaz.

Kısmi fiyat durumunda (`valuationCoverage = "partial"`): bozdurma, yeniden alım,
gerçekleşmemiş ve toplam K/Z kartları "(kısmi)" etiketiyle yalnızca fiyatı bulunan
varlıkların toplamını gösterir; fiyatı olmayan varlıkların maliyet toplamı ayrıca bildirilir;
gerçekleşmiş K/Z fiyattan bağımsızdır ve tamdır; toplam K/Z kesin toplam gibi etiketlenmez.

## 15. Sayı girdisi kuralları (istemci ve sunucuda aynı ayrıştırıcı)

| Girdi | Sonuç |
| --- | --- |
| `12`, `12,5`, `12.5`, `0.125` | kabul (virgül ve nokta ondalık ayırıcı) |
| `1.234,56`, `1.234.567`, `1.234.567,89` | kabul (Türkçe gruplu; iki+ üçlü grup binlik) |
| `1 2` | **ret** — sayının içinde boşluk (12'ye dönüşmez) |
| `5.000`, `1.234`, `12.500` | **ret** — belirsiz (5 mi, 5.000 mi?); `5,000`, `5.000,00` veya `5000` istenir |
| `1,234.56`, `1.2.3`, `1,2,3`, `1e5`, `NaN`, `0x10` | ret |

Gram miktarında en fazla 6 ondalık, adet ürününde yalnızca pozitif tam sayı; tutarlarda en
fazla 4 ondalık, en fazla 12 tam basamak. Formlar düzeltme için değerleri virgüllü Türkçe
biçimde (`toInputDecimal`) yeniden yükler; API kanonik `1234.56` dizesi alır.

## 16. Merkezi quote doğrulaması

Bir fiyat yalnızca `validateUsableQuote(snapshot, quote, productId, now)` kabul ederse
kullanılır: quote mevcut ve istenen ürüne ait; `status = ok`; `liquidation > 0`,
`replacement > 0`, `replacement >= liquidation`; `currency = TRY`; sağlayıcı ve piyasa boş
değil ve anlık görüntünün meta bilgisiyle uyumlu; `providerTimestamp`, quote `fetchedAt` ve
snapshot `fetchedAt` geçerli ISO; hiçbiri 5 dakikadan fazla gelecekte değil; hiçbiri
sağlayıcının `staleAfterMs` süresinden eski değil ("veri şimdi çekilmiş görünse bile sağlayıcı
zamanı eskiyse" bayat); `fetchedAt` `providerTimestamp`'tan (tolerans ötesinde) önce değil.
Başka ürün veya piyasa fiyatı sessizce kullanılmaz. MARKET_BASELINE anlık görüntüsü aynı
kuralları TypeScript (`validatePriceSnapshotInput`, `staleAfterMs` ile) ve Postgres
(`ledger_append`, `stale_after_ms`) tarafında uygular.

## 17. Değerleme ve portföy durumları

| `portfolioState` | Koşul | Arayüz |
| --- | --- | --- |
| `NEVER_USED` | hiç defter kaydı yok | 0 TL, "Henüz altın eklenmedi" |
| `CLOSED` | defter kaydı var, açık pozisyon yok | "Açık pozisyonunuz bulunmuyor"; gerçekleşmiş K/Z ve düğmeler görünür; toplam K/Z = gerçekleşmiş |
| `OPEN` | en az bir açık pozisyon | değerleme `valuationStatus`'a göre |

| `valuationStatus` | Anlamı | Arayüz |
| --- | --- | --- |
| `empty` | açık pozisyon yok | değerleme gerekmez |
| `full` | bütün açık pozisyonlar fiyatlı | tam değerleme |
| `partial` | bir kısmı fiyatlı | "(kısmi)" etiketi; toplamlar yalnızca fiyatı bulunanları kapsar |
| `none` | hiçbiri fiyatlı değil | bozdurma, yeniden alım, gerçekleşmemiş ve toplam K/Z "Fiyat verisi kullanılamıyor" (0 TL değil); elde kalan maliyet ve gerçekleşmiş K/Z görünür |

Bu durum sağlayıcı meta durumundan değil, eldeki pozisyonlar için gerçekten kullanılabilir
quote kapsamından hesaplanır.

## 18. Sayısal sınırlar

Veritabanı sütunları `numeric(20,8)`'dir (en fazla 12 tam basamak). Tutarlar (brüt, toplam,
net, masraf), türetilmiş birim değerler (`total/quantity`, `net/quantity`) ve **birikimli**
pozisyon miktarı / kalan maliyet / gerçekleşmiş K/Z bu sınırı aşamaz; aşan işlem TypeScript'te
`LedgerAmountError` (400), Postgres'te P0004 ile reddedilir. Böylece TypeScript'in kabul ettiği
hiçbir girdi PostgreSQL taşması üretmez. Sayısal metinler sıkı desenle ayrıştırılır (bilimsel
gösterim, NaN, boşluk, bozuk UUID → P0004; BFF geçersiz kimlik biçimini 404'e çevirir).

## 19. Idempotency parmak izi ve defter sürümü

- Demo depoları (bellek / IndexedDB), yerel geliştirme arka ucu ve Postgres aynı semantiği
  uygular: aynı `clientRequestId` + aynı içerik → replay (tek finansal işlem), farklı içerik →
  conflict. Replace işleminde replay yanıtı ilk yanıtla aynı biçimdedir: `[eski ürün pozisyonu,
  (ürün değiştiyse) yeni ürün pozisyonu]`.
- `portfolios.ledger_revision` yalnızca gerçek değişiklikte (ekle / iptal / düzelt / toplu
  iptal) artar; replay ve başarısız işlem artırmaz; elle değiştirilemez. İstemci bu sürümü
  `GET /api/portfolio/version` ile izler ve değişince defter + özeti yeniden okur.
