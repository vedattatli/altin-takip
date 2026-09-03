# Fiyat Çalışma Zamanı Bütünlüğü (Sprint 3.1)

Sprint 3 fiyat **mimarisini** kurdu. Bu sprint, o mimarinin gerçek çalışma yolunda
kopan yerlerini kapattı. Aşağıdaki her madde, "kod var ama akışta çalışmıyor" ya da
"doğru görünüyor ama sessizce yanlış" durumuna karşılık gelir.

## 1. Zamanlanmış alım artık gerçekten çalışabilir

**Sorun:** `POST /api/cron/price-ingestion` tarayıcı sarmalayıcısı `apiRoute` ile
sarılıydı. `apiRoute` her POST'ta `Origin`, `Sec-Fetch-Site` ve imzalı CSRF çerezi
ister. Bir zamanlayıcının elinde bunların hiçbiri yoktur; doğru `PRICE_CRON_SECRET`
gönderse bile istek secret kontrolüne ulaşmadan CSRF aşamasında reddedilirdi.

**Çözüm:** Ayrı bir makine sarmalayıcısı — `src/server/security/machine-route.ts`.

| Özellik | `apiRoute` (tarayıcı) | `machineRoute` (zamanlayıcı) |
| --- | --- | --- |
| Origin / Sec-Fetch-Site | Zorunlu | Bakılmaz |
| İmzalı CSRF çerezi | Zorunlu | Bakılmaz |
| Oturum çözme | Var | **Yok** |
| `Set-Cookie` | Tazeleyebilir | **Hiçbir zaman** |
| Kimlik | Oturum çerezi | `Authorization: Bearer <secret>` veya `X-Cron-Secret` |
| Secret yoksa | — | Uç **kapalı** (403) |
| Karşılaştırma | — | Sabit süreli |

Normal mutation uçlarının CSRF koruması **değişmedi**; testler bunu ayrıca denetler.

Ayrıca `src/proxy.ts` makine yollarına (`/api/cron/`) CSRF çerezi **yazmaz**: bu uçların
tarayıcı oturumu yoktur, çerez gereksizdir ve "makine yanıtı çerez taşımaz" garantisini bozardı.

**Idempotency:** Koşum anahtarı istemciden gelmez. Sunucu, isteğin geldiği anı
dakikaya yuvarlayarak `price-ingestion:<dakika>` üretir. Aynı dakikada tekrarlanan
cron çağrısı aynı anahtarı üretir ve ikinci fiyat geçmişi satırı **oluşmaz**.

## 2. Fiyat sıçrama devre kesicisi akışa bağlandı

**Sorun:** Kalite motorunda `PRICE_JUMP` kontrolü vardı ama gerçek alım çağrısı
`previousLiquidation: undefined` gönderiyordu. Fiyatın bir dakikada 6.000 → 60.000
olması durumunda kontrol **çalışmıyordu**.

**Çözüm:** `ingestProvider`, alımdan önce aynı sağlayıcının güncel kabul edilmiş
fiyatlarını okur ve karşılaştırma haritasını kalite kapısına verir.

Sınırlar:

- Referans yalnızca **aynı sağlayıcının aynı piyasadaki** kaydından alınır.
- Karantinaya alınmış fiyat güncel tabloya yazılmadığı için referans da olamaz.
- İlk alımda önceki değer yoktur; `PRICE_JUMP` uygulanmaz.
- Eşik `PRICE_MAX_CHANGE_RATIO` ile yapılandırılır.
- Referans okuması başarısız olursa alım engellenmez; kontrol sessizce devre dışı
  kalır (referans yokluğu, fiyatı reddetme sebebi değildir).

## 3. Karantina artık kalıcı

**Sorun:** Şüpheli fiyatlar ayrılıyordu ama veritabanına yalnızca **sayı** yazılıyordu.
Hangi ürünün hangi sebeple reddedildiği araştırılamıyordu.

**Çözüm:** `price_quote_quarantine` (migration 0016) — append-only tablo.

Saklananlar: koşum, sağlayıcı, piyasa, kanonik ürün, reddetme kodu, reddedilen
bozdurma/yeniden alım fiyatı, para birimi, sağlayıcı zamanı, çekilme zamanı,
eşleme sürümü, ham yanıt **özeti**.

Saklanmayanlar: ham payload, adres, API anahtarı, çerez, kişisel veri.

Kurallar:

- `anon` ve `authenticated` erişemez; `service_role` yalnızca **okur**.
- UPDATE/DELETE tetikleyiciyle reddedilir (42501).
- Sağlık kaydındaki `quarantined_count` gerçek satır sayısıyla hesaplanır.
- Yönetim ekranı son kayıtları ürün/sebep/kaynak/zaman/fiyat/eşleme ile gösterir.

## 4. Alım RPC'si veritabanı seviyesinde sertleştirildi

`price_ingestion_apply` artık uygulama katmanı atlansa bile şunları doğrular:

| Kural | Davranış |
| --- | --- |
| Sağlayıcı mevcut, **etkin**, lisans durumu uygun | Değilse `P0006` |
| `LICENSED` ise yeniden gösterim izni açık | Değilse `P0006` |
| `REFERENCE_ONLY` sağlayıcı | Güncel değerleme tablosuna **yazamaz** |
| Para birimi | Payload'dan okunur, `TRY` olmalı |
| Fiyatlar | Pozitif olmalı |
| Makas | `replacement >= liquidation` |
| Sağlayıcı zamanı | Geçerli olmalı, 5 dk'dan fazla gelecekte olamaz |
| Kanonik ürün | Katalogda ve aktif olmalı |
| Aynı koşumda yinelenen ürün | `DUPLICATE_CANONICAL_PRODUCT` ile karantinaya alınır |

"Son kayıt kazanır" davranışı **yoktur**: aynı ürün iki kez gelirse ilki korunur,
ikincisi karantinaya yazılır ve koşum `PARTIAL` olur.

## 5. Adapter semantiği

### Taslak (prototype) adapter

Genel JSON okuyucu artık `PrototypeJsonProvider` adını taşır ve **üretim adapter'ı
sayılmaz**. Bir sağlayıcının `LICENSED` olabilmesi için iki koşul birden gerekir:

1. **Kodda fixture:** `src/prices/providers/contracts.ts` içinde o sağlayıcı için
   doğrulanmış bir sözleşme sürümü bulunmalı.
2. **Ortamda beyan:** operatör `*_CONTRACT_VERSION` değişkenine aynı sürümü yazmalı.

Yalnızca `*_API_URL` ve `*_API_KEY` girilmesi kaynağı **açmaz**.

### Zaman damgası kaynağı

`NormalizedQuote` artık `timestampProvenance` taşır:

| Değer | Anlamı | Değerlemeye girer mi? |
| --- | --- | --- |
| `UPSTREAM` | Sağlayıcı fiyatın kendi zamanını bildirdi | Evet |
| `OBSERVED` | Zaman sağlayıcıdan gelmedi; yalnızca gözlem anımız bilinir | Deneysel yolda |
| `UNKNOWN` | Geçerli zaman elde edilemedi | **Hayır** (`TIMESTAMP_PROVENANCE_UNKNOWN`) |

Eksik `providerTimestamp` artık `fetchedAt` ile **doldurulmaz**. Doldurulsaydı bir
saat önceki fiyat "az önce güncellendi" gibi görünür ve tazelik kontrolü anlamsızlaşırdı.

### Para birimi

Yanıttan okunur. Alan yoksa yalnızca sözleşme ucun **yalnızca TL** döndürdüğünü
garanti ediyorsa (`currencyFixedToTry`) TRY kabul edilir. Aksi hâlde kayıt atlanır.

### Yetenek doğruluğu

`capabilities` yalnızca bizde **çalışan adapter'ı bulunan** yetenekleri içerir.
Sağlayıcının sunduğunu söylediği ama karşılığı olmayanlar `advertisedCapabilities`
altında ayrı durur ve yönetim ekranında "sağlayıcı sunuyor, bizde yok" diye gösterilir.
`requiresPersistentWorker` yalnızca **aktif çalışma modu** WebSocket ise true olur.

### Sarraf Pro eşlemesi

`SARRAFPRO_MAPPING` **bilerek boştur**. Önceki sürümdeki semboller (GRAM, CEYREK,
ATA...) yetkili sözleşmeden doğrulanmamış tahminlerdi ve gerçek API'de farklı bir
sembolle eşleşirse fiyat sessizce yanlış ürüne yazılabilirdi. Ekran fizibilitesinde
gözlenen metinler ayrı dosyadadır: `src/prices/providers/sarraf-tv-screen-mapping.ts`.

## 6. Yönetici portföy görünümü

**Sorun:** Yönetici bir kullanıcının portföyünü açtığında eski `getPriceProvider()`
kullanılıyordu; bu fonksiyon her zaman test sağlayıcısını döndürüyordu. Kullanıcı
Kayseri kaynağını seçmiş olsa bile yönetici test fiyatlarıyla hesaplanmış bir
değerleme görüyordu.

**Çözüm:** `PriceSourceService.activeSnapshotForAdmin(admin, targetUserId)` —
**hedef kullanıcının** aktif kaynağı kullanılır. Yalnızca okumadır: kaynak
değiştirmez, tercih yazmaz. Kaynak yoksa test verisine düşülmez; değerleme boş kalır.

## 7. Açık global varsayılan kaynak

**Sorun:** Tercihi olmayan kullanıcıya "listedeki ilk açık kaynak" atanıyordu. Bu
deterministik bir işletme ayarı değildir: sağlayıcı eklendiğinde veya sıralama
değiştiğinde kullanıcıların fiyat kaynağı sessizce değişebilirdi.

**Çözüm:** `price_providers.is_default` — en fazla bir sağlayıcıda true.

- Yönetici açıkça seçer (`PUT /api/admin/price-sources/default`), denetim kaydı oluşur.
- Varsayılan `enabled` + `user_selectable` olmalı ve `REFERENCE_ONLY` olamaz.
- Kaynak kapatılırsa varsayılanlıktan da düşer (tetikleyici + servis birlikte).
- **Kendi tercihini yapmış kullanıcı bu değişiklikten etkilenmez.**
- Varsayılan yoksa kaynak atanmaz; ilk satır seçilmez.

## 8. Test verisi kapısı ayrıldı

**Sorun:** `AUTH_ALLOW_LOCAL_BACKEND` tek başına hem yerel auth arka ucunu hem test
fiyat sağlayıcısını açıyordu. Tek değişken iki farklı güvenlik kararını yönetiyordu.

**Çözüm:** `src/prices/dev-gate.ts` üç kademelidir ve en katı olan kazanır:

1. **Gerçek üretim dağıtımı** (`VERCEL_ENV=production` veya
   `APP_DEPLOYMENT_ENV=production`): test verisi **hiçbir override ile açılamaz**.
2. **Üretim derlemesi** (Playwright): yalnızca `PRICE_ALLOW_MOCK_PROVIDER` belirteciyle.
3. **Geliştirme:** açık.

Ayrıca katalog eşitlemesi, üretimde açık kalmış bir test sağlayıcısını **zorla kapatır**
(`enabled=false`, `user_selectable=false`). Staging'de açılmış test verisi, aynı
veritabanı üretime taşındığında sessizce kullanıcıya gitmez.

## 9. TOTP replay koruması

**Sorun:** `verifyTotp` yalnızca boolean döndürüyordu ve kullanılan zaman adımı
saklanmıyordu. Bir kod 30 saniyelik pencere içinde bir oturumu doğruladıktan sonra
başka bir oturumda tekrar kullanılabilirdi.

**Çözüm:**

- `verifyTotp` eşleşen **sayacı** döndürür (`{ ok, counter }`).
- `admin_mfa_credentials.last_used_counter` sayacı saklar.
- `claimMfaCounter` sayacı **atomik** olarak talep eder: tek koşullu UPDATE
  (`last_used_counter is null or last_used_counter < $2`). İki eşzamanlı istek aynı
  kodu gönderirse yalnızca birinin koşulu tutar.
- Kurulum onayı da sayacı tüketir; aynı kod ikinci oturumu doğrulayamaz.
- ±1 pencere korunur; kurtarma kodu davranışı değişmez.
- MFA sıfırlaması kaydı sildiği için sayaç da temizlenir.

## 10. KAYSARDER kurum adı

"Kayseri Kuyumcular Odası" ifadesi kaldırıldı. Doğru ad **Kayseri Sarraflar ve
Kuyumcular Derneği**'dir. Kaynak beyanı, derneğin fiyat sayfasında `tv.sarraf.pro`
üzerinden yayımlanan Kayseri ekranını tarif eder. Derneğin verinin **sahibi** veya
**resmî API sağlayıcısı** olduğu, yazılı sözleşme olmadan iddia edilmez.

---

## Yeni ortam değişkenleri

| Değişken | Görev |
| --- | --- |
| `PRICE_ALLOW_MOCK_PROVIDER` | Test verisi sağlayıcısının AYRI kapısı (yalnızca test koşucusu) |
| `APP_DEPLOYMENT_ENV` | `production` ise test verisi ve deneysel toplayıcı koşulsuz kapalı |
| `PRICE_EXPERIMENTAL_SARRAF_SCREEN` | Deneysel ekran toplayıcısı (yerel/özel staging) |
| `ALTINAPI_CONTRACT_VERSION` | Operatörün sözleşme sürümü beyanı |
| `HASFIYAT_CONTRACT_VERSION` | Aynı |
| `SARRAFPRO_CONTRACT_VERSION` | Aynı (doğrulanmış sürüm yok; beyan edilse de açılmaz) |

## İlgili belgeler

- [PRICE_PROVIDERS.md](PRICE_PROVIDERS.md) — sağlayıcı kataloğu ve lisans kapısı
- [SARRAF_TV_FEASIBILITY.md](SARRAF_TV_FEASIBILITY.md) — ekran fizibilitesi (otomatik üretilir)
- [RUNBOOKS.md](RUNBOOKS.md) — kesinti, karantina ve MFA kurtarma kılavuzları
