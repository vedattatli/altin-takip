# Özel Pilot Dağıtımı

Bu belge pilotu **sıfırdan ayağa kaldırma** adımlarıdır. Sıra önemlidir; her
adımın sonunda ne göreceğiniz yazılıdır.

Bu bir **özel pilottur**, halka açık üretim değildir. Kayıt formu yoktur;
hesapları yalnızca yönetici açar.

---

## 0. Önce bilinmesi gerekenler

| Konu | Durum |
| --- | --- |
| Kullanıcı bilgisayarına kurulum | **Yok.** EXE/MSI/BAT/Python/eklenti yoktur. |
| Erişim | Normal tarayıcı, HTTPS adresi |
| Hesap açma | Yalnızca yönetici |
| Fiyat kaynağı | Kayseri ekran gözlemi, **lisanssız**, sınırlı ürün |
| Özel alan adı | Yok — platformun verdiği HTTPS adresi kullanılır |
| Mağaza paketi | Yok — PWA olarak ana ekrana eklenebilir |

Fiyat kaynağının ölçülmüş sınırları: [PRICE_SOURCE_STATUS.md](PRICE_SOURCE_STATUS.md)

---

## 1. Gerekli hesaplar

| Servis | Ne için | Ücretsiz katman yeter mi |
| --- | --- | --- |
| Supabase | Postgres veritabanı | Evet (pilot ölçeği) |
| Vercel | Web uygulaması | Evet |
| GitHub Actions | Ekran fiyat toplayıcısı (zamanlanmış görev) | **Evet** — ücretsiz kota içinde; kalıcı container YOK |

> Fiyat toplama ücretsizdir: GitHub Actions'ta saatte bir çalışan
> tek seferlik bir görevdir. Kalıcı container, ücretli plan veya kişisel
> bilgisayara kurulum GEREKMEZ. Ayrıntı: `docs/CLOUD_PRICE_COLLECTOR.md`.

### Terminal oturumları

Dağıtımdan önce kendi terminalinizde bir kez:

```bash
npx supabase login
npx vercel login
railway login          # veya Render arayüzü
```

---

## 2. Supabase projesi

```bash
npx supabase projects create altin-takip-pilot --region eu-central-1
npx supabase link --project-ref <PROJE_REF>
npx supabase db push
```

`db push` bütün migration'ları sırayla uygular (0001 → 0017).

**Doğrulama:**

```bash
npx supabase db lint
```

Ayrıca Supabase panelinde `price_providers` tablosunda `sarraf-tv-kayseri-screen`
satırının `license_status = EXPERIMENTAL_PRIVATE` ile bulunduğunu görün.

---

## 3. Secret üretimi

Aşağıdaki değerler **kriptografik olarak rastgele** üretilir, kaynak koda
yazılmaz, log'lanmaz, ZIP'e konmaz, `NEXT_PUBLIC_` altında kullanılmaz.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Her biri için ayrı ayrı çalıştırın:

| Değişken | Nerede kullanılır |
| --- | --- |
| `AUTH_CSRF_SECRET` | Tarayıcı isteklerinin CSRF imzası |
| `AUTH_MFA_ENCRYPTION_KEY` | Yönetici TOTP sırlarının şifrelenmesi |
| `RATE_LIMIT_PEPPER` | Hız sınırı anahtarlarının karıştırılması |
| `PRICE_CRON_SECRET` | Cron ucunun paylaşılan sırrı |
| `PRICE_SCREEN_WORKER_SECRET` | Worker HMAC imzası (worker ve uygulamada **aynı**) |

Üretilen değerleri doğrudan platformun secret alanına yapıştırın. Terminal
çıktısında bırakmayın, sohbete yapıştırmayın, dosyaya kaydetmeyin.

---

## 4. Vercel dağıtımı

```bash
npx vercel link
npx vercel env add <DEĞİŞKEN> production   # her değişken için
npx vercel --prod
```

### Zorunlu ortam değişkenleri

Değerleri platformun secret alanına girin; bu belgeye veya koda yazmayın.

| Değişken | Değer |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase proje adresi |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon anahtarı |
| `SUPABASE_SECRET_KEY` | Supabase servis anahtarı — **sunucu tarafı**, asla `NEXT_PUBLIC_` altında değil |
| `AUTH_INTERNAL_EMAIL_DOMAIN` | `altin-takip.local` |
| `AUTH_SESSION_COOKIE` | `altin_session` |
| `AUTH_CSRF_SECRET` | Bölüm 3'te üretilen |
| `AUTH_MFA_ENCRYPTION_KEY` | Bölüm 3'te üretilen |
| `RATE_LIMIT_PEPPER` | Bölüm 3'te üretilen |
| `PRICE_CRON_SECRET` | Bölüm 3'te üretilen |
| `PRICE_SCREEN_WORKER_SECRET` | Bölüm 3'te üretilen — worker ile **aynı** değer |
| `PRICE_EXPERIMENTAL_SARRAF_SCREEN` | `true` |
| `APP_DEPLOYMENT_ENV` | `production` |
| `APP_ORIGIN` | Vercel'in verdiği HTTPS adresi |
| `PRICE_ALLOW_MOCK_PROVIDER` | `false` |

`PRICE_ALLOW_MOCK_PROVIDER=false` önemlidir: üretim dağıtımında sahte fiyat
sağlayıcısı devre dışı kalır. Kod bunu ayrıca kontrol eder
(`src/prices/dev-gate.ts`).

**Doğrulama:** Adresi açın, `/giris` ekranını görün. Henüz kullanıcı yoktur.

---

## 5. İlk yönetici hesabı

Yerel terminalinizde, üretim ortam değişkenleriyle:

```bash
npm run admin:create
```

Kullanıcı adını ve parolayı **komut sorduğunda siz girersiniz**. Parola ekrana
yazılmaz, kabuk geçmişine düşmez, hiçbir yerde saklanmaz.

**Doğrulama:** `/giris` → yönetici adı + parola → MFA kurulum ekranı gelir.
QR kodu okutun, 6 haneli kodu girin, kurtarma kodlarını güvenli yere kaydedin.

Sonrası: [ADMIN_QUICK_START.md](ADMIN_QUICK_START.md)

---

## 6. Ekran worker'ı (isteğe bağlı, ücretli)

Worker olmadan uygulama tamamen çalışır; yalnızca Kayseri fiyatları gelmez.

### Railway

```bash
railway init
gh workflow run sarraf-price-collector.yml --repo <kullanici>/altin-takip --ref main
```

### Ortam değişkenleri

| Değişken | Değer |
| --- | --- |
| `APP_BASE_URL` | Vercel'in verdiği HTTPS adresi |
| `PRICE_SCREEN_WORKER_SECRET` | Vercel'dekiyle **aynı** değer |
| `PRICE_EXPERIMENTAL_SARRAF_SCREEN` | `true` |
| `SARRAF_SCREEN_URL` | Okunacak ekran adresi |
| `WORKER_ID` | `sarraf-screen-1` |
| `OBSERVE_INTERVAL_MS` | `60000` |
| `PORT` | `8080` |

> Worker'a **Supabase anahtarı verilmez.** Veritabanına doğrudan erişimi yoktur;
> yalnızca imzalı makine ucuna yazar. Bu kasıtlıdır: worker ele geçirilse bile
> defteri okuyamaz veya değiştiremez.

**Doğrulama:**

1. `https://<worker-adresi>/healthz` → `200`
2. `/yonetim/deneysel-kaynak` → "Tarayıcı worker durumu" kirayı tutuyor gösterir
3. Son gözlem zamanı 90 dakikadan yenidir (saatlik bulut koşumu; gecikebilir)

---

## 7. Pilot kullanıcısı açma

1. `/yonetim` → yeni kullanıcı oluşturun, geçici parolayı kullanıcıya iletin.
2. `/yonetim/deneysel-kaynak` → **Kullanıcı izin listesi** → kullanıcıyı ekleyin.
3. Kullanıcı girer, parolasını değiştirir, `/fiyat-kaynagi` ekranından Kayseri
   ekran kaynağını seçer.

Bu kaynak genel listede **görünmez**; yalnızca izin verilen kullanıcıda çıkar.

---

## 8. Uçtan uca doğrulama

Sırayla yapın. Her adımın karşısındaki sonucu görmelisiniz.

| # | Adım | Beklenen |
| --- | --- | --- |
| 1 | Bilgisayardan giriş | Panel açılır |
| 2 | Telefondan aynı hesapla giriş | **Aynı** portföy görünür |
| 3 | Telefondan alış ekle | Bilgisayarda yenileyince görünür |
| 4 | Aynı üründen farklı fiyatla ikinci alış | Ortalama maliyet güncellenir |
| 5 | Kısmi satış | Gerçekleşmiş K/Z hesaplanır |
| 6 | Elde olandan fazlasını satmayı dene | Reddedilir, neden yazılır |
| 7 | Gremse ürününe bak | Kayseri fiyatı ve "Son ekran gözlemi" görünür |
| 8 | Desteklenmeyen bir ürüne bak | "güvenilir Kayseri fiyatı alınamıyor" uyarısı |
| 9 | Worker'ı durdur, 3 dakika bekle | Fiyat gösterilmez; **uydurma fiyat çıkmaz** |
| 10 | Worker'ı başlat | Fiyat geri gelir |

9. adım pilotun en önemli testidir: sistem bilmediğinde bunu söyler.

---

## 9. Dağıtım sonrası kontrol listesi

- [ ] `npm run verify:bundle` temiz (istemci paketinde secret izi yok)
- [ ] `NEXT_PUBLIC_` altında hiçbir secret yok
- [ ] `PRICE_ALLOW_MOCK_PROVIDER=false`
- [ ] Worker'da Supabase anahtarı yok
- [ ] Yönetici MFA kurulu, kurtarma kodları saklandı
- [ ] Kayıt formu yok (yalnızca yönetici hesap açar)
- [ ] Deneysel kaynak global varsayılan **değil**
- [ ] Deneysel kaynak genel kullanıcı listesinde **görünmüyor**

---

## 10. Geri alma

| Ne | Nasıl |
| --- | --- |
| Pilot kullanıcısını durdur | İzin listesinden kapat |
| Fiyat kaynağını durdur | GitHub Actions iş akışını devre dışı bırak |
| Uygulamayı geri al | `npx vercel rollback` |
| Veritabanını geri al | **Migration'lar geri alınamaz.** Yedekten dönülür. |

Veritabanı geri alma gerektirecek bir değişiklik yapmadan önce Supabase
panelinden yedek alın.

## Dağıtım bloke olursa: commit yazarı kuralı

Vercel, Git bağlantılı projelerde **commit yazarının** dağıtım yetkisi olup
olmadığını denetler. Yazar tanınmıyorsa dağıtım hiç başlamaz; API'de şöyle
görünür:

```
readyState: BLOCKED
readyStateReason: The deployment was blocked because the commit author
                  doesn't have permission to create deployments for this project.
```

Belirti kafa karıştırıcıdır: `vercel ls` durumu `UNKNOWN` gösterir, CLI
"Building…" der ve dakikalarca bekler, `vercel inspect --logs` hiçbir şey
yazmaz. **Yapı hiç başlamamıştır.**

Sebebi teşhis etmek için:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const token = JSON.parse(readFileSync(process.env.APPDATA + '/xdg.data/com.vercel.cli/auth.json','utf8')).token;
const r = await fetch('https://api.vercel.com/v13/deployments/<DPL_ID>?teamId=<TEAM_ID>', {
  headers: { Authorization: 'Bearer ' + token },
});
const j = await r.json();
console.log(j.readyState, j.readyStateReason);
"
```

Çözüm: commit'i projenin tanıdığı kimlikle at. Deponun kendi ayarı zaten
doğrudur; `git -c user.email=...` ile **ezmeyin**.

```bash
git config user.email   # proje hesabının e-postası olmalı
git commit -m "..."     # -c ile kimlik ezilmeden
```

Dağıtım HEAD commit'inin yazarına bakar; yalnız son commit'in doğru kimlikle
atılması yeterlidir.
