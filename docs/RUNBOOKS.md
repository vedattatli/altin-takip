# Operasyon Kılavuzları (Runbook)

Bu belge, olay anında ne yapılacağını adım adım anlatır. Komutlar hiçbir secret değeri
yazdırmaz; eksik ayarları yalnızca DEĞİŞKEN ADIYLA raporlar.

## 1. Fiyat sağlayıcı kesintisi

**Belirti:** Panelde "Fiyat verisi kullanılamıyor" veya kaynak durumu "Bayat".

1. Yönetim → **Fiyat kaynakları** ekranını açın. İlgili kaynağın son koşumuna, sağlık
   durumuna ve güvenli hata koduna bakın.
   - `HTTP_401` / `HTTP_403`: anahtar veya lisans sorunu. Sağlayıcıyla iletişime geçin.
   - `TIMEOUT` / `NETWORK`: geçici erişim sorunu. "Şimdi güncelle" ile tekrar deneyin.
   - `NOT_CONFIGURED` / `LICENSE_REQUIRED`: ortam değişkeni veya izin eksik.
   - `PARTIAL_COVERAGE`: bazı ürünler eşlenemedi; sembol eşlemesini gözden geçirin.
2. **Başka kaynağa sessizce geçmeyin.** Uygulama bunu zaten yapmaz. Gerekirse yönetici olarak
   başka bir kaynağı etkinleştirip kullanıcıya açın; kullanıcı kendi onayıyla geçer.
3. Kesinti uzarsa kaynağı "Kapat" ile devre dışı bırakın. Kullanıcılar açık olan başka bir
   kaynağı seçebilir; hiçbir kaynak yoksa değerleme gösterilmez, portföy verisi korunur.
4. Kesinti sonrası "Şimdi güncelle" ile doğrulayın ve sağlık kaydının `ok` olduğunu görün.

**Etki:** Fiyat kesintisi defteri, maliyetleri veya gerçekleşmiş kâr/zararı etkilemez.
Yalnızca güncel değerleme gösterilmez.

## 2. Karantina artışı (şüpheli fiyat)

1. Yönetim → Fiyat kaynakları: sayfanın altındaki **"Son karantina kayıtları"** tablosuna
   bakın. Her satır ürünü, sebebi, reddedilen fiyatı, zamanı ve eşleme sürümünü gösterir.
   Aynı veri `GET /api/admin/price-sources/quarantine?kaynak=<kod>&limit=50` ile de okunur.
2. Sık görülen nedenler: ters makas, aşırı fiyat sıçraması, bayat sağlayıcı zamanı, bilinmeyen
   sembol.
3. Sık görülen kodlar ve anlamları:
   - `PRICE_JUMP`: önceki kabul edilmiş fiyata göre aşırı sıçrama (devre kesici).
   - `INVERTED_SPREAD`: satış < alış. Sütunlar ters olabilir; DÜZELTİLMEZ, reddedilir.
   - `TIMESTAMP_PROVENANCE_UNKNOWN`: sağlayıcı fiyat zamanı bildirmedi.
   - `CURRENCY_NOT_TRY`: para birimi yanıtta TL değil veya hiç yok.
   - `DUPLICATE_CANONICAL_PRODUCT`: aynı koşumda aynı ürün iki kez geldi.
4. Eşikler ortam değişkenleriyle ayarlanır: `PRICE_MAX_CHANGE_RATIO`, `PRICE_MAX_SPREAD_RATIO`,
   `PRICE_STALE_AFTER_MS`. Eşiği gevşetmeden önce sağlayıcı verisini doğrulayın.
5. Sembol eşlemesi değiştiyse `src/prices/providers/mappings.ts` güncellenir ve
   `mappingVersion` artırılır.

## 2.1 Global varsayılan fiyat kaynağı

Kendi seçimini yapmamış kullanıcılara AÇIK bir varsayılan atanır; "listedeki ilk kaynak"
davranışı yoktur.

1. Yönetim → Fiyat kaynakları → ilgili kaynakta **"Varsayılan yap"**.
2. Varsayılan `enabled` + `user_selectable` olmalı ve referans kaynağı olamaz.
3. Kaynak kapatılırsa varsayılanlıktan da düşer; bu durumda tercihi olmayan kullanıcılara
   kaynak ATANMAZ ve değerleme boş kalır (test verisine düşülmez).
4. **Kendi tercihini yapmış kullanıcılar bu değişiklikten etkilenmez.**

## 3. Yedekleme ve geri yükleme

**Yedek (staging veya üretim):**

```bash
npx supabase db dump --linked -f yedek-$(date +%Y%m%d).sql
```

- Yedek dosyası kullanıcı verisi içerir: şifreli bir konumda saklayın, depoya koymayın.
- Doğrulama: dosya boyutu > 0 ve `pg_dump` başlığı var mı?

**Geri yükleme (yalnızca boş/yeni bir projeye):**

1. Yeni Supabase projesi oluşturun ve `npx supabase link --project-ref <ref>` ile bağlanın.
2. Migration'ları uygulayın: `npm run staging:migrate` (veya `supabase db push`).
3. Yedeği yükleyin: `psql "<connection-string>" -f yedek-YYYYMMDD.sql`
4. Doğrulayın: `npm run accounting:verify` (tutarsızlık 0 olmalı) ve
   `npm run test:data-api` (sınır ihlali 0 olmalı).

**Not:** Defter append-only'dir; geri yükleme sonrası pozisyon projeksiyonu
`accounting:verify` ile karşılaştırılır. Tutarsızlık varsa RPC ile yeniden oluşturulur.

## 4. Yönetici ikinci faktörü kurtarma

1. Yönetici kimlik doğrulayıcısını kaybederse önce **kurtarma kodunu** kullanır.
2. Kurtarma kodu da yoksa BAŞKA bir yönetici sıfırlar:
   - Yönetim → kullanıcı ayrıntısı → ikinci faktörü sıfırla.
   - Onay için kullanıcı adı birebir yazılır.
   - Sıfırlama ayrı denetim kaydı üretir ve hedefin bütün oturumlarını kapatır.
3. Tek yönetici varsa ve erişim tamamen kaybolduysa: sunucu ortamından
   `AUTH_MFA_ENCRYPTION_KEY` değiştirilmez; bunun yerine `npm run admin:create` ile yeni bir
   yönetici hesabı açılır ve o hesap eski yöneticinin MFA'sını sıfırlar.

**Uyarı:** `AUTH_MFA_ENCRYPTION_KEY` kaybedilirse mevcut TOTP kayıtları çözülemez; bütün
yöneticilerin ikinci faktörü sıfırlanmalıdır. Anahtarı yedekleyin.

**"Bu kod zaten kullanıldı" hatası:** aynı TOTP kodu 30 saniyelik pencerede yalnızca bir kez
kabul edilir (replay koruması). Bir sonraki kodu bekleyin. Bu bir arıza değildir.

Aynı kural otomasyon için de geçerlidir: birden çok oturumu arka arkaya açan betikler her
oturum için YENİ bir pencere beklemelidir (bkz. `e2e/helpers.ts` → `waitForFreshTotpWindow`).

## 5. Sağlık kontrolü

```bash
curl -s -X POST https://<staging-url>/api/cron/price-ingestion \
  -H "X-Cron-Secret: <PRICE_CRON_SECRET>"
```

- `403`: secret yanlış veya tanımsız (uç kapalı).
- `200`: yanıt her sağlayıcı için `status`, `accepted`, `quarantined` ve güvenli hata kodu
  içerir; secret veya ham payload İÇERMEZ.

Diğer kontroller:

| Kontrol | Komut | Beklenen |
| --- | --- | --- |
| Defter ↔ projeksiyon | `npm run accounting:verify` | tutarsızlık 0 |
| Veri API sınırı | `npm run test:data-api` | ihlal 0 |
| Fiyat alımı yolu | `npm run price:smoke` | bütün kontroller ok |
| Sağlayıcı sözleşmesi | `npm run price:contract` | fixture testleri geçer; canlı NOT_RUN |

## 6. Kullanıcı veri talepleri

- **Dışa aktarma:** kullanıcı Ayarlar → "İşlemleri/Pozisyonları CSV indir".
- **Silme talebi:** Ayarlar → "Hesap ve veri silme talebi". Talep denetim kaydına yazılır.
- **Silme:** yönetici, kullanıcı ayrıntısında kullanıcı adını birebir yazarak siler. Silme
  cascade ile profil, portföy, defter, anlık görüntü, pozisyon, oturum ve tercihleri kaldırır.
- Silmeden önce kullanıcıya CSV dışa aktarma hatırlatılır.
