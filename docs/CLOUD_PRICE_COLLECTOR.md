# Bulut fiyat toplayıcısı (GitHub Actions)

Fiyatlar **GitHub Actions üzerinde zamanlanmış, tek seferlik** bir görevle
toplanır. Sürekli çalışan bir worker **yoktur**.

Tek koşum **iki ayrı yol** izler ve bunlar birbirini engellemez:

| Yol | Kaynaklar | Tarayıcı gerekir mi? |
| --- | --- | --- |
| HTTP | Kapalıçarşı (Anlık Altın), Türkiye geneli (Trunçgil) | **Hayır** — düz sunucu isteği |
| Ekran | Sarraf TV Kayseri | **Evet** — bayi fiyatı yalnız DOM'da hesaplanıyor |

HTTP yolunda runner yalnızca uygulamanın zamanlanmış ucunu **tetikler**;
sağlayıcıları uygulamanın kendisi okur. Böylece runner'a Supabase erişimi
verilmez.

## Neden bu mimari

| Gereksinim | Karşılığı |
| --- | --- |
| Kimsenin bilgisayarı açık kalmasın | Görev GitHub'ın Ubuntu runner'ında çalışır |
| Ücret ödenmesin | GitHub Actions ücretsiz kotası içinde |
| Son kullanıcı kurulum yapmasın | Kullanıcılar yalnız web adresini açar |
| Kalıcı container olmasın | Her koşum bağımsızdır; açılır, okur, kapanır |

Vedat'ın bilgisayarı **kapalıyken de** sistem çalışır. Uygulamanın hiçbir
parçası kişisel bir makineye bağlı değildir.

## Akış

```
GitHub Actions (Ubuntu runner)
  → POST /api/cron/price-ingestion  (Kapalıçarşı + Türkiye geneli, tarayıcısız)
  → Chromium açılır
  → Sarraf TV Kayseri ekranı yüklenir
  → açılış ağ yanıtı beklenir (yön kanıtı)
  → güvenilir satırlar çıkarılır
  → HMAC imzalı gözlem makine ucuna gönderilir
  → tarayıcı ve job kapanır
```

## Zamanlama ve kota

| Öğe | Değer |
| --- | --- |
| Program | `17 * * * *` — saatte bir, 17. dakika |
| Neden 17. dakika | Tam saatteki runner yoğunluğundan kaçınmak için |
| Ücretsiz kota | 2000 dakika/ay (private repo) |

### Neden 30 dakikada bir değil

GitHub Actions **iş (job) başına** dakikayı **yukarı yuvarlayarak** faturalar.
Koşum 70 saniye sürse bile 2 dakika yazılır.

| Sıklık | Günlük koşum | Faturalanan/gün | Aylık | Kota (2000) |
| --- | --- | --- | --- | --- |
| Saatte bir | 24 | ~48 dk | ~1440 dk | **%72 — kota içinde** |
| 30 dakikada bir | 48 | ~96 dk | ~2880 dk | %144 — **kotayı aşar** |

Bu yüzden program **saatte bir**dir ve arayüzde de saatte bir olarak yazar;
"anlık" veya "saniyelik" iddiası **yoktur**.

İki kaynağı ayrı iş (job) olarak kurmak da aynı sebeple yapılmadı: her iş
ayrı yuvarlanır ve saatlik programda ~2160 dakikaya çıkardı.

GitHub zamanlanmış koşumları yoğun anlarda **geciktirebilir**. Bu bir hata
değildir; bayatlık politikası buna göre ayarlanmıştır.

> Zamanlanmış iş akışları yalnız **varsayılan daldan** (`main`) çalışır.
> Değişiklik `main`'e gitmezse program eski kodu koşturur.

## Bayatlık politikası

| Gözlem yaşı | Durum | Davranış |
| --- | --- | --- |
| 0–90 dakika | **Güncel** | Fiyat değerlemede kullanılır |
| 90–180 dakika | **Bayat** | Kullanıcıya açıkça bayat gösterilir |
| 180 dakikadan fazla | **Kullanılamıyor** | Fiyat kabul **edilmez** |

Eski sürekli-worker modelindeki 120 saniyelik eşik burada kullanılmaz; saatlik
koşumda her fiyatı reddederdi.

Fiyat gelmediğinde **başka kaynağa veya test verisine geçilmez**. Uygulama
"fiyat alınamıyor" der ve değerleme hesaplamaz.

## Elle çalıştırma

```bash
gh workflow run sarraf-price-collector.yml --repo vedattatli/altin-takip --ref main
```

Yerelde denemek için:

```bash
npm run price:sarraf:collect-once     # ekran kaynağı (Playwright)
npm run price:ingest:trigger          # HTTP kaynakları (sunucu tarafı alım)
npm run price:anlik:collect-once      # yalnız okuma denetimi, yazmaz
npm run price:truncgil:collect-once   # yalnız okuma denetimi, yazmaz
```

Gerekli ortam değişkenleri: `APP_BASE_URL`, `SARRAF_SCREEN_URL`,
`PRICE_SCREEN_WORKER_SECRET`, `PRICE_SCREEN_WORKER_ID`.

## Çıkış kodları

| Kod | Anlamı |
| --- | --- |
| 0 | Fiyat kabul edildi |
| 75 | Geçici: kira başkasında, ekran okunamadı veya kabul edilen fiyat yok |
| 76 | CAPTCHA etkileşim istedi — **çözülmez**, koşum başarısız sayılır |
| 1 | Yapılandırma veya beklenmeyen hata |

75 durumunda koşum başarısız görünür ve bu **kasıtlıdır**: fiyat gelmediğini
sessizce başarı saymak yanlış olur.

## Secret'lar

GitHub Actions Secrets içinde durur, koda yazılmaz, loga düşmez:

- `ALTIN_TAKIP_APP_URL`
- `PRICE_CRON_SECRET` — yalnız zamanlanmış alım ucunu açar
- `PRICE_SCREEN_WORKER_SECRET`
- `PRICE_SCREEN_WORKER_ID`
- `SARRAF_SCREEN_URL`

Runner'a Supabase `service_role` **verilmez**. Toplayıcı yalnız HMAC makine
ucunu bilir; veritabanına doğrudan erişemez.

## Sorun giderme

| Belirti | Bakılacak yer |
| --- | --- |
| Fiyat güncellenmiyor | Actions sekmesinde son koşumun sonucu |
| Koşum 75 ile bitiyor | Ekran yapısı değişmiş olabilir; `screenSignature` |
| Koşum 76 ile bitiyor | Kaynak CAPTCHA istiyor; beklenir, aşılmaz |
| Program hiç çalışmıyor | Değişiklikler `main` dalında mı? |
| Fiyat bayat görünüyor | Son gözlem 90 dakikadan eski; koşumu elle tetikleyin |
