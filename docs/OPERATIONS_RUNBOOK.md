# Operasyon Kılavuzu (özel pilot)

Belirti → neden → yapılacak. Her bölüm bağımsız okunabilir.

---

## 0. Sistem neyden oluşur

| Parça | Nerede çalışır | Ne yapar |
| --- | --- | --- |
| Web uygulaması | Vercel | Arayüz + API uçları |
| Veritabanı | Supabase (Postgres) | Defter, portföy, fiyat, denetim kayıtları |
| Fiyat toplayıcı | GitHub Actions (zamanlanmış) | Saatte bir Chromium açar, Kayseri ekranını okur, kapanır |

Worker **ayrı** bir servistir çünkü Vercel fonksiyonu içinde kalıcı bir tarayıcı
çalıştırılamaz. Worker'a **Supabase anahtarı verilmez**; yalnızca imzalı bir
makine ucuna yazar.

### Veri akışı

```
Kayseri ekranı (tarayıcı)
   → worker DOM'dan okur, HMAC ile imzalar
   → POST /api/internal/price-worker/sarraf-screen
   → kira + nonce doğrulaması
   → merkezî kalite kapısı (aynı kapı bütün kaynaklar için)
   → price_ingestion_apply (append-only)
   → kullanıcı paneli
```

Hiçbir adım atlanamaz. Worker'ın yazdığı fiyat da diğer kaynaklarla **aynı**
kalite kapısından geçer.

---

## 1. Fiyatlar güncellenmiyor

### Kontrol sırası

1. `/yonetim/deneysel-kaynak` → **Tarayıcı worker durumu**.
   - "Kira tutulmuyor" yazıyorsa worker çalışmıyordur → adım 2.
   - Son gözlem 2 dakikadan eskiyse fiyat kasıtlı olarak gösterilmez → adım 2.
2. Worker servisinin `/healthz` ucuna bakın. Yanıt gövdesinde `healthy`,
   `status`, `lastSuccessAt`, `lastErrorCode` ve `restartCount` vardır.

   | Yanıt | Anlamı | Yapılacak |
   | --- | --- | --- |
   | `200`, `status: ok` | Gözlem üretiyor | Sorun başka yerde |
   | `200`, `status: degraded`, `lastErrorCode: LEASE_NOT_HELD` | **Yedek worker**, kirayı başka örnek tutuyor. Sağlıklıdır | Kirayı tutan örneğe bakın |
   | `200`, `lastSuccessAt: null`, açılıştan <3 dk | Açılış payı içinde | 3 dakika bekleyin |
   | `503` | Süreç ayakta ama gözlem üretmiyor | Adım 3 |
   | Yanıt yok | Container ölü | Platform yeniden başlatmalı; başlatmıyorsa elle başlatın |

   **Önemli:** "Süreç yaşıyor" sağlıklı sayılmaz. Worker son 3 aralık (en az 3
   dakika) içinde başarılı gözlem üretmediyse `/healthz` **503** döner; böylece
   platformun kurtarma mekanizması gerçekten tetiklenir. Tek istisna, kirayı
   başka worker'ın tuttuğu yedek örnektir.
3. Worker log'larına bakın. Aranacak satırlar:

| Log | Anlamı | Yapılacak |
| --- | --- | --- |
| `SIGNATURE_MISMATCH` | Ekranın yapısı değişmiş | Bölüm 4 |
| `CAPTCHA` | Bot koruması etkileşim istedi | Bölüm 5 |
| `NO_ROWS` | Sayfa yüklendi ama satır yok | Bölüm 4 |
| `LEASE_NOT_HELD` | Başka bir worker kirayı tutuyor | Bölüm 3 |
| `LEASE_TOKEN_STALE` | Worker eski kira jetonuyla yazmaya çalıştı | Kendiliğinden düzelir; worker yeniden kira alır |
| `browser_restart` / `reason: disconnected` | Sayfa çöktü veya donduysa **beklenen** kurtarma | Sıklığına bakın; aşağıya bakın |
| `READ_FAILED` | Okuma yapılamadı | Bir sonraki turda kurtarma tetiklenir |

### `browser_restart` çok sık görünüyorsa

Hedef sayfa uzun koşumlarda Chromium'u çökertiyor; bu **ölçülmüş** bir
davranıştır ve worker bundan kurtulacak şekilde yazıldı. Arada bir yeniden
başlatma normaldir.

Sorun sayılacak eşik: dakikada birden fazla yeniden başlatma. O durumda
GitHub Actions koşum kaydına bakın (`Actions` sekmesi) ve
platformda ayrılan belleği artırın. Çökme her olduğunda o tur fiyat
üretilmez ve açılış imzası yeniden öğrenilir; kullanıcı tarafında bu, fiyatın
1–2 dakika gelmemesi olarak görünür ve **uydurma fiyat gösterilmez**.

**Yapmayın:** Fiyatı elle veritabanına yazmayın. Bayat fiyatı "geçici olarak"
göstermeye çalışmayın. Fiyat yoksa yoktur; uygulama bunu zaten doğru şekilde
bildirir.

---

## 2. Worker'ı yeniden başlatma

Worker kendini şu durumlarda zaten yeniden başlatır: tarayıcı bağlantısı
koptuğunda, 6 saatte bir planlı olarak, bellek sınırı aşıldığında, üst üste
hata aldığında (üstel geri çekilme + jitter ile).

Elle başlatmak gerekirse platformun restart düğmesi yeterlidir. Kira TTL'i
kısa olduğu için yeni örnek kısa sürede kirayı devralır; ikinci bir örneği
elle silmeniz gerekmez.

`SIGTERM`/`SIGINT` alındığında worker mevcut gözlemi tamamlar ve tarayıcıyı
düzgün kapatır.

---

## 3. Aynı anda iki worker

Kira (lease) mekanizması bunu **zaten engeller**: yalnızca bir worker yazabilir.
İkincisi `held: false` alır ve beklemeye geçer.

Kira sahibi ölürse TTL dolduğunda ikinci worker devralır (`takeover: true`).
Eski worker geri gelirse yazması `LEASE_TOKEN_STALE` ile reddedilir — eski
verinin yeniyi ezmesi mümkün değildir.

Kalıcı olarak iki worker çalıştırmayın; gereksizdir ve log'ları karıştırır.

---

## 4. Ekran yapısı değişti (`SIGNATURE_MISMATCH`)

Worker her gözlemde ekranın yapısal imzasını hesaplar:
`headers:...|rows:N|directional:M`. İmza beklenenden farklıysa **fiyat üretmez**.

Bu bilinçli bir tasarımdır: sütunlar yer değiştirdiyse alış fiyatını satış
sanmak, hiç fiyat göstermemekten çok daha kötüdür.

Yapılacak:

1. Fizibilite aracını çalıştırın:
   ```bash
   npm run price:sarraf-feasibility:headless
   ```
2. `artifacts/sarraf-tv/headless/run-report.json` içindeki `screen.signature`
   ve `screen.rowCount` değerlerine bakın.
3. Ekran gerçekten değiştiyse eşleme sürümünü
   (`SARRAF_TV_SCREEN_MAPPING_VERSION`) yükseltip eşlemeyi güncelleyin.
   **Eski onaylar yeni sürüme taşınmaz** — yönetici yeniden onaylar.

Bu bir kod değişikliğidir; pilot sırasında normal bir bakımdır.

---

## 5. CAPTCHA çıktı

Worker CAPTCHA gördüğünde durur ve fiyat üretmez.

**CAPTCHA çözülmez, atlatılmaz, otomatikleştirilmez.** Bu kesin bir kuraldır.
Bot koruması bir sınırdır, aşılacak bir engel değil.

Yapılacak: pilotu duraklatın ve durumu kaydedin. Kalıcı bir çözüm isteniyorsa
doğru yol lisanslı bir veri sözleşmesidir — teknik bir "çözüm" değil.

---

## 6. Karantina doldu

`/yonetim/fiyat-kaynaklari` → karantina listesi.

| Kod | Muhtemel neden | Yapılacak |
| --- | --- | --- |
| `PRICE_JUMP` | Gerçek piyasa hareketi ya da okuma hatası | Ekrana bakıp fiyatı doğrulayın |
| `OBSERVATION_STALE` | Worker geride kalıyor | Bölüm 1 |
| `OBSERVATION_INVALID` | İmza/yön sorunu | Bölüm 4 |
| `SPREAD_TOO_WIDE` | Sütun hizalaması bozulmuş olabilir | Bölüm 4 |

Karantina **append-only**'dir; kayıtlar silinmez. Sayının artması sistemin
çalıştığının işaretidir — kötü veri içeri girmiyor demektir.

---

## 7. Kullanıcı "fiyat göremiyorum" diyor

Sırayla:

1. Kullanıcı izin listesinde mi? (`/yonetim/deneysel-kaynak`)
2. Baktığı ürün desteklenen ürünlerden mi? Şu an yalnızca **Gremse** doğrudan
   çalışır; Çeyrek/Yarım/Tam **onay** bekler.
3. Worker sağlıklı mı? (Bölüm 1)

Üçü de tamamsa ve hâlâ fiyat yoksa, kalite kapısı o fiyatı reddetmiştir —
karantinaya bakın.

---

## 8. Yönetici MFA'sı kilitlendi

- Kurtarma kodlarınız varsa biriyle girin, sonra `/yonetim` üzerinden MFA'yı
  sıfırlayın.
- Kurtarma kodları da yoksa: `npm run admin:repair` komutu terminal erişimi
  olan kişi tarafından çalıştırılır. Bu komut yalnızca sunucu erişimi olan
  kişide çalışır; arayüzden karşılığı **yoktur** (kasıtlı).

---

## 9. Veri bütünlüğü kontrolü

```bash
npm run accounting:verify
```

Defterle türetilmiş pozisyonları karşılaştırır. Çıktıdaki iki sayı da `0` olmalıdır:

- `DB içi doğrulama tutarsızlığı: 0`
- `Motor karşılaştırma tutarsızlığı: 0`

Sıfır değilse **hiçbir şeyi elle düzeltmeyin**. Defter append-only'dir; tutarsızlık
bir hesaplama hatasına işaret eder ve kod düzeyinde incelenmelidir.

---

## 10. Sürüm çıkma

```bash
npm run verify        # lint + typecheck + test + build
npm run verify:bundle # istemci paketinde secret sızıntısı taraması
npm run test:db       # pgTAP (yerel Supabase gerekir)
npm run test:e2e      # Playwright
```

Migration'lar sırayla ve **geri alınamaz** biçimde uygulanır. Uygulamadan
**önce** migration çalıştırın; kod eski şemayla çalışmaz.

Worker imajı ayrı dağıtılır. Eşleme sürümü değiştiyse worker ile uygulamanın
aynı sürümü kullandığından emin olun; farklıysa yazma reddedilir (bu doğru
davranıştır).

---

## 11. Pilotu durdurma

En hızlı ve güvenli yol: `/yonetim/deneysel-kaynak` → izin listesindeki bütün
kullanıcıları kapatın.

Bu, kullanıcıları başka bir kaynağa **düşürmez**; fiyat gösterilmez ve nedeni
yazılır. Portföy verisi, defter ve geçmiş **etkilenmez**.

Fiyat toplamayı da durdurmak isterseniz GitHub Actions iş akışını devre dışı
bırakın. Uygulama tarafında
hiçbir şey bozulmaz; fiyatlar bayatlar ve gösterilmez.
