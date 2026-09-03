# Yönetici Hızlı Başlangıç

Bu belge pilotun yöneticisi içindir. Sıra önemlidir.

---

## 1. İlk yönetici hesabı

Yönetici hesabı **arayüzden oluşturulamaz**. Yalnızca terminalden, tek komutla:

```bash
npm run admin:create
```

Komut kullanıcı adını ve parolayı **çalışma anında sorar**. Parola:

- ekrana yazılmaz (yankısız okunur),
- kabuk geçmişine düşmez,
- log'lanmaz,
- kaynak kodda veya bu belgede **yoktur**.

Parolayı siz belirlersiniz. Kimse — bu belgeyi yazan da dâhil — göremez.

> `admin` rolü yalnızca bu komutla verilir. Uygulamanın hiçbir ekranı bir
> kullanıcıyı yöneticiye yükseltemez.

---

## 2. Yönetici çok adımlı doğrulama (MFA)

İlk yönetici girişinde MFA kurulumu zorunludur.

1. `/giris` üzerinden yönetici kullanıcı adı + parola ile girin.
2. Ekrandaki QR kodu telefonunuzdaki doğrulayıcı uygulamasına okutun
   (Google Authenticator, Microsoft Authenticator, 1Password, Authy — hepsi olur).
3. Uygulamanın verdiği 6 haneli kodu girin.
4. **Kurtarma kodlarını** görürsünüz. Bunları güvenli bir yere kaydedin;
   bir daha gösterilmezler. Her kod bir kez kullanılır.

Kod tekrar kullanılamaz: aynı 6 haneli kod ikinci kez kabul edilmez (replay
koruması). Kod yazarken zaman penceresi dolarsa yeni kodu bekleyin.

Telefonunuzu kaybederseniz kurtarma kodlarından biriyle girer, sonra
`/yonetim` üzerinden MFA'yı sıfırlayabilirsiniz.

---

## 3. Kullanıcı oluşturma

`/yonetim` ekranı.

1. **Yeni kullanıcı** deyin.
2. Kullanıcı adını yazın (Türkçe karakter kuralları ve ayrılmış adlar kontrol
   edilir).
3. Sistem bir **geçici parola** üretir. Bunu kullanıcıya kendiniz iletin.
4. Kullanıcı ilk girişte parolasını değiştirir. **O andan sonra parolayı siz de
   göremezsiniz.**

Her kullanıcı için bir portföy kendiliğinden oluşturulur. Kullanıcılar
birbirlerinin verisini göremez; bu hem uygulama katmanında hem veritabanı
satır güvenliğiyle (RLS) uygulanır.

### Yapabilecekleriniz

| İşlem | Nerede |
| --- | --- |
| Kullanıcı oluştur | `/yonetim` |
| Parola sıfırla (geçici parola üret) | `/yonetim/<kullanıcı>` |
| Hesabı pasifleştir / yeniden aç | `/yonetim/<kullanıcı>` |
| Oturumları sonlandır | `/yonetim/<kullanıcı>` |
| Portföyünü görüntüle | `/yonetim/<kullanıcı>` |
| MFA sıfırla | `/yonetim/<kullanıcı>` |

Her yönetici işlemi `admin_audit_logs` tablosuna yazılır: kim, ne zaman, hangi
kullanıcı için. Bu kayıt silinemez.

**Yapamayacaklarınız:** kullanıcının parolasını okumak, kullanıcı adına işlem
girmek, bir kullanıcıyı yönetici yapmak.

---

## 4. Fiyat kaynağını açma

`/yonetim/fiyat-kaynaklari` ekranı.

- Lisanssız kaynaklar **açılamaz**. Kısıt veritabanındadır; arayüzden zorlanamaz.
- `MARKET_BASELINE` yalnızca geliştirme ortamında kullanılır ve "gerçek piyasa
  verisi değil" rozetiyle işaretlenir.
- Global varsayılan kaynak burada seçilir. Deneysel kaynak **varsayılan
  yapılamaz**.

---

## 5. Deneysel Kayseri ekran kaynağı

`/yonetim/deneysel-kaynak` ekranı. Üç bölüm vardır.

### 5.1 Tarayıcı worker durumu

Ekran fiyatlarını okuyan worker'ın kirayı tutup tutmadığını, son gözlem
zamanını ve yeniden başlatma sayısını gösterir.

Worker durmuşsa fiyat **eskimeye başlar** ve 2 dakika sonra uygulama fiyatı
göstermeyi bırakır. Bayat fiyatla hesap yapılmaz.

### 5.2 Kullanıcı izin listesi

Bu kaynak genel listeye **açılamaz**. Hangi kullanıcının kullanabileceğini
buradan tek tek verirsiniz. İsteğe bağlı bitiş zamanı verebilirsiniz.

İzin geri alındığında kullanıcı başka bir kaynağa **sessizce düşürülmez**;
fiyat gösterilmez ve nedeni yazılır.

### 5.3 Ekran eşleme onayları

Ekrandaki bazı başlıklar hangi ürün olduğunu tek anlamlı söylemez. Örnek:
ekranda "ÇEYREK" yazar ama yeni çeyrek mi eski çeyrek mi belli değildir.

Bu satırlar `CONVENTION` güveniyle işaretlenir ve **onay verilene kadar
değerlemeye girmez**.

Onaylarken şunları görürsünüz: ham ekran etiketi, önerilen ürün, o andaki alış
ve satış değeri, gözlem zamanı. Doğru olduğuna kendiniz karar verirsiniz.
Onay `OPERATOR_VERIFIED` olarak kim/ne zaman bilgisiyle saklanır ve geri
alınabilir.

Şu an durum: **GREMSE** doğrudan çalışır; **ÇEYREK, YARIM, TAM** onayınızı
bekler. Ayrıntı: [PRICE_SOURCE_STATUS.md](PRICE_SOURCE_STATUS.md)

---

## 6. Karantina ve fiyat kalitesi

`/yonetim/fiyat-kaynaklari` ekranında karantina listesi vardır.

Bir fiyat kalite kapısından geçemezse **kullanılmaz** ve nedeniyle birlikte
saklanır:

| Kod | Anlamı |
| --- | --- |
| `PRICE_JUMP` | Bir önceki fiyattan kabul edilemez oranda sapma |
| `SPREAD_TOO_WIDE` | Alış/satış makası fazla açık |
| `OUT_OF_RANGE` | Mantıksız tutar |
| `STALE` | Kaynağın kendi zaman damgası çok eski |
| `OBSERVATION_STALE` | Ekran gözlemi 2 dakikadan eski |
| `OBSERVATION_INVALID` | Gözlem tutarsız (imza değişmiş, yön doğrulanmamış) |
| `TIMESTAMP_PROVENANCE_UNKNOWN` | Zamanın kökeni bilinmiyor |

Karantinaya düşen fiyat sessizce atılmaz; listede görünür. Reddedilen fiyatın
yerine eski fiyat kullanılmaz — fiyat yoksa yoktur.

---

## 7. Günlük kontrol (2 dakika)

1. `/yonetim/deneysel-kaynak` → worker kirayı tutuyor mu, son gözlem kaç
   saniye önce?
2. `/yonetim/fiyat-kaynaklari` → karantinada beklenmedik artış var mı?
3. `/panel` → Gremse fiyatı görünüyor mu?

Üçü de iyiyse pilot sağlıklıdır.

Sorun giderme: [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)
