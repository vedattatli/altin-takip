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
- Deterministik sıra: `occurred_at` (`traded_at`), `created_at`, `ledger_sequence`.
- Geçmiş tarihli kayıt eklenince, iptal edilince veya düzeltilince ürünün
  pozisyonu defterden **yeniden oynatılır**.
- Geçmişteki bir değişiklik sonraki bir satışı eldeki miktarın üstüne çıkarıyorsa
  işlemin tamamı reddedilir; defter değişmez.

Türetilmiş projeksiyon `public.portfolio_positions` yalnızca performans içindir;
elle düzenlenemez (service_role'e bile yalnızca SELECT verilir) ve
`npm run accounting:verify` ile defterden yeniden hesaplanıp karşılaştırılır.

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
