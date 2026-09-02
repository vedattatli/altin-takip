# Altın Takip

Türkiye'deki altın portföylerini telefonda, tablette ve bilgisayarda tek yerden takip etmek için
geliştirilen responsive web uygulaması ve PWA.

- Kurulum gerektirmez: tarayıcıda çalışır, ana ekrana uygulama olarak eklenebilir.
- EXE, MSI, BAT, tarayıcı eklentisi veya yerel yardımcı yoktur; şirket bilgisayarlarında
  hiçbir program kurmadan kullanılır. PWA kurulumu tamamen isteğe bağlıdır.
- Excel, Python veya yönetici izni gerekmez.
- Hesaplar **yalnızca yönetici tarafından** oluşturulur; herkese açık kayıt yoktur.
- Giriş **kullanıcı adı + parola** iledir. E-posta, telefon, OTP veya sihirli bağlantı kullanılmaz.
- Fiyatlar bu sürümde **test verisidir**; gerçek piyasa verisi değildir.

Ürün adı tek bir yerden yönetilir: [`src/config/app.config.ts`](src/config/app.config.ts).

---

## Hızlı başlangıç (yerel geliştirme)

Supabase hesabı olmadan da uygulamayı uçtan uca çalıştırabilirsiniz. Bu durumda **yalnızca
geliştirme ortamında** çalışan yerel bir kimlik doğrulama arka ucu devreye girer.

```bash
npm install
```

```bash
cp .env.example .env.local
```

```bash
npm run admin:create -- --local
```

Komut kullanıcı adı ve görünen adı sorar, parolayı görünmeden alır ve ekrana yazdırmaz.

```bash
npm run dev
```

`http://localhost:3000` adresine gidin ve oluşturduğunuz yönetici hesabıyla giriş yapın.
Yönetim ekranından son kullanıcıları oluşturabilirsiniz.

> Yerel arka uç verileri `.data/auth-local.json` dosyasında tutulur. Bu dosya `.gitignore` ile
> dışlanmıştır ve üretim derlemesinde kullanılamaz. Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md).

---

## Supabase ile kurulum

1. Supabase'de yeni bir proje oluşturun.
2. `.env.local` dosyasını doldurun:

   | Değişken | Açıklama |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Proje URL'si |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anahtar (RLS ile korunur) |
   | `SUPABASE_SERVICE_ROLE_KEY` | **Yalnızca sunucu.** `NEXT_PUBLIC_` öneki asla verilmez |
   | `AUTH_INTERNAL_EMAIL_DOMAIN` | Kullanıcı adından türetilen dahili kimliğin alan adı |

3. `supabase/migrations/` altındaki SQL dosyalarını **sırayla** çalıştırın:

   ```
   0001_init.sql                 -> tablolar, kısıtlar, indeksler
   0002_rls.sql                  -> satır düzeyi güvenlik politikaları
   0003_seed_reference_data.sql  -> altın ürün kataloğu ve fiyat kaynağı
   ```

4. İlk yöneticiyi oluşturun:

   ```bash
   npm run admin:create
   ```

Supabase bilgileri eksikse bu komut **gerçek kullanıcı oluşturmuş gibi davranmaz**; hangi
değişkenlerin eksik olduğunu raporlar.

---

## Komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run dev` | Geliştirme sunucusu |
| `npm run build` | Üretim derlemesi |
| `npm run start` | Üretim sunucusu |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript tip denetimi |
| `npm run test` | Birim ve güvenlik yüzeyi testleri (Vitest) |
| `npm run test:e2e` | Tarayıcı duman testleri (Playwright, 390/768/1440 px) |
| `npm run verify` | lint + typecheck + test + build |
| `npm run admin:create` | İlk yönetici hesabını oluşturur |
| `npm run icons` | PWA simgelerini koddan üretir |
| `npm run db:catalog` | Ürün kataloğunu SQL migration'ına yazar |

---

## Kullanıcı ve yönetici modeli

- **Kayıt yok.** Kullanıcıları yalnızca yönetici oluşturur.
- Yönetici geçici parola belirler; kullanıcı **ilk girişte parolasını değiştirmek zorundadır**.
- Yönetici hiçbir zaman mevcut parolayı göremez; yalnızca yeni geçici parola atayabilir.
- Parola sıfırlandığında veya hesap pasifleştirildiğinde **tüm cihazlardaki oturumlar düşer**.
- Varsayılan yönetim işlemi **pasifleştirmedir**. Kalıcı silme ayrı ve açık onay ister:
  hedefin kullanıcı adı birebir yazılmalıdır.
- `admin` rolü yalnızca `npm run admin:create` ile verilir; arayüzden verilemez.

Kullanıcı adı kuralları: 3–32 karakter, harf ile başlar, `a-z 0-9 . _ -` kullanılabilir, boşluk
içermez, büyük/küçük harfe duyarsızdır, Türkçe harfler ASCII karşılığına çevrilir
(`ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u`).

Parola kuralları: en az 10 karakter, en az bir harf ve bir rakam, yaygın/ardışık parolalar ve
kullanıcı adını içeren parolalar reddedilir.

---

## Fiyat verisi

Bu sürümde yalnızca `MockPriceProvider` kullanılır ve arayüzde **Test Verisi** olarak etiketlenir.

- Alış ve satış fiyatları birbirine çevrilmez; ayrı alanlardır.
- Bir sağlayıcı çalışmadığında başka bir piyasanın fiyatına sessizce geçilmez.
- Bayat veri "güncel" diye sunulmaz; son fiyat zamanı her zaman görünür.
- Hiçbir siteden izinsiz veri çekilmez. Gerçek fiyat entegrasyonu yalnızca lisanslı bir sağlayıcı
  sözleşmesiyle `LicensedPriceProvider` olarak eklenecektir.

---

## Şirket ve ortak cihazlar

Giriş ekranında cihaz türü seçilir. Güvenli varsayılan **"Şirket / ortak cihaz"**tır.

| | Kişisel cihaz | Şirket / ortak cihaz |
| --- | --- | --- |
| Oturum çerezi | Kalıcı | Tarayıcı kapanınca silinir |
| Hareketsizlik | Sınır yok | **15 dakikada otomatik çıkış** |
| Servis çalışanı / önbellek | Kayıtlı (yalnızca statik varlıklar) | Kaydedilmez, mevcut önbellekler temizlenir |
| PWA kurulum çağrısı | Tarayıcı gösterebilir | Bastırılır |
| Cihazda saklanan veri | Yok | Yok |

Her iki modda da:

- Oturum jetonu yalnızca `HttpOnly`, `Secure`, `SameSite=Lax` çerezde taşınır; JavaScript ile
  okunamaz.
- Parola veya erişim jetonu `localStorage` / `sessionStorage` / IndexedDB gibi JavaScript'ten
  okunabilir depolara **yazılmaz**.
- Portföy bulut veritabanında saklanır; cihazlar arası senkronizasyon sunucu üzerinden yapılır.
- Bildirim, push, konum veya kamera izni istenmez.
- Kurulu PWA ile normal tarayıcı kullanımı arasında görsel ve işlevsel fark yoktur.

Ayrıntı: [docs/SECURITY.md](docs/SECURITY.md) bölüm 12.

## Demo modu

Demo modu yalnızca **geliştirme ortamında** ve `NEXT_PUBLIC_ENABLE_DEMO_MODE=true` iken `/demo`
adresinde açılır. Üretim derlemesinde 404 döner ve giriş ekranında hiçbir demo bağlantısı görünmez.
Demo verileri yalnızca tarayıcının IndexedDB deposunda tutulur, sunucuya gitmez ve cihazlar arasında
senkronize olmaz.

---

## Belgeler

| Belge | İçerik |
| --- | --- |
| [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Ürün gereksinimleri ve kapsam |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Katmanlar, kimlik doğrulama akışı, dosya haritası |
| [docs/SECURITY.md](docs/SECURITY.md) | Kimlik doğrulama, yetkilendirme, RLS, denetim kaydı |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tablolar, ilişkiler, indeksler |
| [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md) | Kabul kriterleri ve karşılık gelen testler |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Sonraki sprintler |
| [CLAUDE.md](CLAUDE.md) | Bu depoda çalışan yapay zekâ ajanları için kurallar |
