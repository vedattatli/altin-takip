# Fiyat Kaynakları (Sprint 3)

Uygulama birden çok fiyat kaynağını destekler. Amaç, farklı piyasaların verisini
**karıştırmadan**, lisans durumu açıkça bilinen ve kullanıcıya dürüstçe etiketlenen tek bir
kanonik biçimde sunmaktır.

> Bu sürümde hiçbir gerçek sağlayıcı lisansı yoktur. Bütün gerçek kaynaklar
> `NOT_CONFIGURED` veya `LICENSE_REQUIRED` durumundadır; yalnızca test verisi çalışır ve
> arayüzde "Gerçek piyasa verisi değil" etiketiyle görünür.

## 1. Değişmez kurallar

- **Scraping yok.** KAYSARDER, Sarraf TV, Altınkaynak ve Harem sayfaları scrape edilmez;
  gizli/özel WebSocket trafiği reverse engineer edilmez. Yalnızca resmî/yetkili API veya XML
  sözleşmesi kullanılır.
- **Hayali endpoint yok.** Sözleşmesi bilinmeyen kaynak için adres yazılmaz; taban adres
  operatörün elindeki sözleşmeden `*_API_URL` ile gelir. Adres yoksa sağlayıcı veri çekmez.
- **Fail closed.** Yeniden gösterim izni (`*_REDISTRIBUTION_ALLOWED`) açıkça `true` değilse
  kaynak lisanslı sayılmaz, etkinleştirilemez ve kullanıcıya sunulamaz.
- **Sessiz fallback yok.** Aktif kaynak başarısız olursa başka sağlayıcıya veya başka şehrin
  fiyatına geçilmez. Son geçerli fiyat zamanıyla birlikte "bayat" olarak bildirilir; değerleme
  hesaplanmış gibi gösterilmez. Üretimde hiçbir kaynak seçili değilse de test verisine
  düşülmez: açılış bakiyesi (MARKET_BASELINE) oluşturulmaz ve değerleme boş kalır.
- **API anahtarı yalnızca sunucuda.** İstemci paketine girmez, loglanmaz, veritabanında
  saklanmaz. Veritabanı yalnızca lisans referansını ve durumu tutar.
- **Dürüst etiket.** Hiçbir sağlayıcı, bağlı olmadığı bir kurumun "resmî" servisi gibi anılmaz.

## 2. Katalog

| Kod | Kullanıcıya görünen ad | Teknik ad | Piyasa | Durum |
| --- | --- | --- | --- | --- |
| `mock` | Test Verisi | MockPriceProvider | Test | `DEV_ONLY` — üretim dağıtımında koşulsuz kapalı (`src/prices/dev-gate.ts`) |
| `sarraf-pro-kayseri` | Kayseri Yerel Piyasa | Sarraf Pro (KAYSARDER ekranı) | Kayseri | `NOT_CONFIGURED` — yetkili API/XML sözleşmesi bekleniyor |
| `altinapi` | Genel Türkiye | AltinAPI — bağımsız veri sağlayıcısı | Genel Türkiye | `NOT_CONFIGURED` — anahtar ve lisans bekleniyor |
| `hasfiyat` | Hasfiyat Çoklu Kaynak | Hasfiyat — çoklu kaynak birleşimi | Çoklu Kaynak | `NOT_CONFIGURED` |
| `altinkaynak-direct` | Altınkaynak (doğrudan) | Resmî API sözleşmesi bekleniyor | Genel Türkiye | `LICENSE_REQUIRED` — adapter kapalı |
| `harem-direct` | Harem Altın (doğrudan) | Resmî API sözleşmesi bekleniyor | Genel Türkiye | `LICENSE_REQUIRED` — adapter kapalı |
| `bist-reference` | BIST Referans (yalnızca kontrol) | BIST — referans/anomali | BIST | `LICENSE_REQUIRED`, `REFERENCE_ONLY` |

**KAYSARDER**'ın resmî adı **Kayseri Sarraflar ve Kuyumcular Derneği**'dir ("Kuyumcular Odası"
değildir). Derneğin fiyat sayfası, canlı ekranı `tv.sarraf.pro` üzerinden yayımlar. Dernek, bu
verinin sahibi veya resmî API sağlayıcısı olarak — yazılı sözleşme olmadan — anılmaz.

**AltinAPI**, Harem Altın'ın veya başka bir kurumun resmî servisi **değildir**; bağımsız bir
veri sağlayıcısıdır ve arayüzde böyle etiketlenir.

**Hasfiyat** birden çok üst kaynağı birleştirir. Üst kaynak (`HASFIYAT_SOURCE` veya yanıttaki
`source` alanı) biliniyorsa adı gösterilir; bilinmiyorsa veri tek bir kurumun fiyatı gibi
etiketlenmez, **"Çoklu Kaynak"** olarak sunulur.

**BIST** referans kaynağıdır: değerlemede birincil kaynak olamaz, yerel ziynet (çeyrek, Ata,
Reşat) bozdurma hesabında kullanılmaz. Yalnızca veri sapması ve sağlık kontrolü içindir.

## 2.1 Taslak adapter ve sözleşme doğrulaması

Gerçek sağlayıcıların hepsi şu anda **taslak** JSON adapter'ı (`PrototypeJsonProvider`)
kullanır. Bu adapter birden çok alan adını dener; sözleşmesi doğrulanmamış bir API'de
sessizce yanlış sütunu okuyabilir. Bu yüzden `*_API_URL` ve `*_API_KEY` girilmesi bir
kaynağı üretimde AÇMAZ. İki koşul birden gerekir:

1. **Kodda fixture:** `src/prices/providers/contracts.ts` içinde o sağlayıcı için
   doğrulanmış bir sözleşme sürümü.
2. **Ortamda beyan:** operatör `*_CONTRACT_VERSION` ile aynı sürümü yazar.

Sarraf Pro için doğrulanmış sürüm **yoktur**; beyan edilse bile kaynak açılmaz.

## 3. Bir kaynağı üretimde açmak

1. Sağlayıcıyla **yazılı lisans/izin** sözleşmesi yapılır (yeniden gösterim dâhil).
2. Sunucu ortamına yalnızca o kaynağın değişkenleri yazılır (`.env.example`'daki adlarla):
   adres, anahtar, lisans referansı ve `*_REDISTRIBUTION_ALLOWED=true`.
3. Sembol eşlemesi `src/prices/providers/mappings.ts` içinde doğrulanır; değişirse
   `mappingVersion` artırılır (eski kayıtların hangi eşlemeyle üretildiği izlenebilir kalır).
   Sarraf Pro eşlemesi sözleşme gelene kadar BOŞTUR; tahmini sembol eklenmez.
3b. Sözleşme sürümü `contracts.ts` içine fixture'ıyla eklenir ve `*_CONTRACT_VERSION` ile
   beyan edilir.
4. Yönetim → **Fiyat kaynakları** ekranında "Bağlantıyı test et" çalıştırılır.
5. Kaynak "Etkinleştir" ve gerekiyorsa "Kullanıcıya aç" ile açılır. Lisans yoksa sunucu
   etkinleştirmeyi `409` ile reddeder.

Lisans kaybedilirse katalog eşitlemesi kaynağı otomatik olarak kapatır (fail closed).

## 4. Merkezi alım (ingestion)

```
Sağlayıcı → sunucu ingestion → doğrulama/karantina → kanonik eşleme
          → current_price_quotes (upsert) + price_quote_history (append-only)
          → kullanıcı uygulaması
```

- Kullanıcının tarayıcısı sağlayıcıya **bağlanmaz**; yalnızca bizim API'mizi okur.
- Aynı sağlayıcı için iki alım **paralel çalışmaz** (`pg_try_advisory_xact_lock`); ikinci çağrı
  `SKIPPED` döner.
- Aynı koşum anahtarı iki kez uygulanmaz (idempotent); tarihçede çift kayıt oluşmaz.
- Varsayılan aralık **60 saniye**, `PRICE_INGESTION_INTERVAL_MS` ile 15 sn – 5 dk arasında
  ayarlanabilir.
- Zamanlanmış uç `POST /api/cron/price-ingestion`, `PRICE_CRON_SECRET` ile korunur; secret
  yoksa uç kapalıdır. Test sağlayıcısı üretim cron'unda çalışmaz.
- **Katalog kendiliğinden hazırlanır.** Fiyat kaynağı okuyan veya yazan her giriş noktası
  eşitlemenin en az bir kez yapıldığını garanti eder (arka uç başına bir kez, idempotent).
  Böylece yönetim sayfası hiç açılmamış yeni bir kurulumda da kaynak listesi doğru gelir.
- WebSocket destekleyen sağlayıcılar için istek ömrü içinde kalıcı bağlantı **açılmaz**;
  kalıcı worker gerektiren mod ayrı çalışma zamanı olarak tasarlanmıştır. Worker yoksa REST
  alımı kullanılır.

## 5. Kalite kapısı ve karantina

Her quote merkezi doğrulamadan geçer: ürün/sağlayıcı/piyasa eşleşmesi, `buy > 0`, `sell > 0`,
`sell >= buy`, TL para birimi, geçerli zaman damgaları, gelecek toleransı (5 dk), tazelik
sınırı, "çekilme zamanı sağlayıcı zamanından önce" tutarsızlığı, makas genişliği
(`PRICE_MAX_SPREAD_RATIO`), makul fiyat aralığı (`PRICE_MIN_TRY` / `PRICE_MAX_TRY`) ve önceki
fiyata göre aşırı sıçrama (`PRICE_MAX_CHANGE_RATIO`).

Şüpheli quote **güncel değerlemeye girmez**, karantinaya alınır, sağlık kaydında sayılır ve
yönetim ekranında güvenli hata koduyla görünür.

## 6. Kaynak seçimi

- Bir portföyde **tek** aktif sağlayıcı/piyasa kullanılır.
- Kullanıcı yalnızca yöneticinin açtığı (`enabled` + `user_selectable`) kaynakları görür.
- Hiç seçim yapmamış kullanıcı için yöneticinin **açıkça belirlediği** global varsayılan
  kullanılır. "Listedeki ilk açık kaynak" davranışı YOKTUR: varsayılan tanımlı değilse
  kaynak atanmaz ve değerleme boş kalır. Kendi tercihini yapmış kullanıcı, global varsayılan
  değiştiğinde etkilenmez.
- Piyasa kimliği arayüzde ham gösterilmez; okunur adla ("Kayseri Yerel Piyasa") sunulur.
- Değişiklik açık onay ister:
  > Fiyat kaynağını değiştirmek güncel portföy değerinizi ve görünen gerçekleşmemiş kâr/zararı
  > değiştirebilir. Geçmiş işlem maliyetleriniz ve başlangıç snapshot'larınız değişmez.
- Her değişiklik `price_source_change_events` kaydı ve denetim izi üretir.
- Karşılaştırma ekranındaki fiyatlar **değerlemeye karışmaz**; yalnızca gösterim içindir.

## 7. Muhasebeye etkisi

Kaynak değişimi:

| Etkilenmez | Etkilenir |
| --- | --- |
| BUY işlemindeki gerçek ödenen tutar | Güncel bozdurma / yeniden alım değeri |
| SELL işlemindeki gerçek tahsilat | Gerçekleşmemiş K/Z |
| `MARKET_BASELINE` snapshot'ı | Değerleme kapsamı (tam / kısmi / yok) |
| Gerçekleşmiş K/Z | |

Fiyatı bulunmayan ürünlerde mevcut kısmi/none değerleme davranışı korunur.

## 8. Ekran gözlemi kaynağı (özel pilot)

`sarraf-tv-kayseri-screen` diğer kaynaklardan **ayrı** bir kimliktir ve bilerek
farklı davranır:

| Konu | Diğer kaynaklar | Ekran kaynağı |
| --- | --- | --- |
| Sağlayıcı türü | `REST` / `XML` / `WEBSOCKET` | `SCREEN` |
| Lisans durumu | `LICENSED` gerekir | `EXPERIMENTAL_PRIVATE` — lisanslı **değildir** |
| Kullanıcıya açık mı | Yönetici açabilir | **Asla** — izin listesiyle kişi bazlı |
| Global varsayılan | Olabilir | **Olamaz** |
| Zaman damgası | `UPSTREAM` | `OBSERVED` (kaynağın kendi saati bilinmez) |
| Veri kanalı | HTTP yanıtı | Tarayıcı DOM'u (fiyatlar tarayıcıda hesaplanır) |
| Toplayıcı | Uygulama içi cron | Ayrı, kalıcı worker container'ı |
| Ürün kapsamı | Katalog geneli | Yalnızca değerlemeye hazır güvendeki satırlar |

Kalite kapısı **aynıdır**. Ekran kaynağının yazdığı fiyat da `evaluateQuote`
üzerinden geçer; ayrıca `OBSERVATION_STALE` ve `OBSERVATION_INVALID` kodları
yalnızca bu kaynak için ek kontrol getirir.

Durum, ölçüm ve sınırlar: [PRICE_SOURCE_STATUS.md](PRICE_SOURCE_STATUS.md)
Mimari ve worker: [ARCHITECTURE.md](ARCHITECTURE.md) bölüm 14.
