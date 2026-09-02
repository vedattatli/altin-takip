# Bu depoda çalışırken uyulacak kurallar

Bu dosya, projede çalışan yapay zekâ ajanları ve geliştiriciler için bağlayıcı kurallardır.

## Çalışma biçimi

- **Alt ajan, Task agent, agent team, paralel ajan veya worktree kullanma.** Bütün inceleme,
  planlama, kodlama ve testleri doğrudan yap.
- **Başka ajanlara görev devretme.** İşi bölme, tek elden yürüt.
- Gereksiz yeniden yazım yapma. Mevcut mimariyi bozmadan uyarla.
- Gereksiz bağımlılık ekleme. Yeni paket eklemeden önce standart kütüphane veya mevcut kodla
  çözülüp çözülemeyeceğine bak.
- Uzun teorik açıklama yerine dosyayı yaz, kodu çalıştır, sonucu doğrula.

## Her değişiklikten sonra

```bash
npm run verify
```

Bu komut sırayla `lint`, `typecheck`, `test`, `build` ve `verify:bundle` çalıştırır.
Beşi de geçmeden işi tamamlanmış sayma. Arayüzü veya güvenlik katmanını etkileyen
değişikliklerde ayrıca:

```bash
npm run test:e2e
```

Veritabanı politikalarını değiştirdiysen (ortam destekliyorsa):

```bash
npm run test:db
```

## Güvenlik kuralları (ihlal edilemez)

- **Secret commit etme.** `.env.local`, gerçek anahtarlar, parolalar, tokenlar asla depoya girmez.
  Yalnızca `.env.example` commit edilir ve içinde gerçek değer bulunmaz.
- **`SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` istemciye gönderilmez.** Bu anahtara yalnızca
  `src/server/` altındaki `import "server-only"` işaretli modüller erişebilir. `NEXT_PUBLIC_` öneki
  verilmesi yasaktır; API yanıtına veya istemci paketine girmez (`npm run verify:bundle`).
- **Kendi parola hash sistemini yazma.** Üretimde parola custody'si Supabase Auth'a aittir.
  Uygulama tablolarında `password`, `password_hash` gibi bir sütun oluşturma.
  (Tek istisna: `src/server/auth/local-backend.ts` — yalnızca geliştirme test ikizidir ve üretimde
  hata fırlatır. Yeni kod bu deseni örnek almamalıdır.)
- **Kullanıcı izolasyonunu RLS ile koru.** Yeni tablo eklerken `enable row level security` +
  `force row level security` ve `user_id = auth.uid()` politikaları yazılmadan migration
  tamamlanmış sayılmaz. `user_id` ve RLS'de filtrelenen alanlara indeks ekle.
- **Rol istemciden alınmaz.** Hiçbir API ucu gövdeden `role` kabul etmez. `admin` rolü yalnızca
  `npm run admin:create` ile verilir.
- **Yetki kontrolü sunucuda yapılır.** Menü gizlemek güvenlik önlemi değildir; her admin ucu
  `requireCurrentAdmin()` çağırmak zorundadır.
- **Denetim kaydına hassas veri yazma.** `admin_audit_logs` içine parola, parola özeti, tutar veya
  işlem detayı yazılmaz.
- Herkese açık kayıt ucu veya sayfası ekleme. E-posta OTP, sihirli bağlantı, telefon girişi,
  `signInWithOtp`, `resetPasswordForEmail` kullanma.

## Dağıtım ve cihaz kuralları

- **Yerel kurulum gerektiren hiçbir şey üretme:** EXE, MSI, BAT, PowerShell betiği, tarayıcı
  eklentisi, native helper, Electron/Tauri kabuğu. Uygulama normal HTTPS web uygulamasıdır.
- **PWA kurulumunu zorunlu kılma.** Hiçbir özellik `display-mode: standalone` kontrolüne veya
  servis çalışanına bağlı olamaz. `beforeinstallprompt` yalnızca bastırmak için kullanılır;
  `prompt()` çağrılmaz.
- **Parola veya oturum jetonunu JavaScript'ten okunabilir depoya yazma.** `localStorage`,
  `sessionStorage` ve `document.cookie` uygulama kodunda kullanılmaz. Oturum yalnızca
  `Secure` + `HttpOnly` + `SameSite=Lax` çerezle taşınır.
- **Oturum modelini bozma:** cihaz türü seçimi, istemci tarafı hareketsizlik sayacı veya
  istemci tarafı otomatik çıkış EKLEME. Tek tercih "Bu cihazda oturumumu açık tut" kutusudur;
  süre sınırları yalnızca sunucuda uygulanır. Kalıcı oturum yalnızca açık çıkış veya güvenlik
  olayıyla (parola sıfırlama, pasifleştirme, yönetici iptali, silme) kapanır. Cihaz izni istenmez.
- **Servis çalışanına hassas yanıt yazma.** `/api/*` ve kimliği doğrulanmış sayfa yanıtları
  önbelleğe alınmaz.
- Kullanıcı portföyü bulut veritabanında saklanır; cihazlar arası senkronizasyon sunucu
  üzerinden yapılır.

## Yetkilendirme sınırı (ihlal edilemez)

- **BFF içinde RLS UYGULANMAZ.** Sunucu Supabase'e `service_role` ile bağlanır ve
  bu anahtar RLS'yi atlar. Birincil güvenlik sınırı **sunucu tarafı actor
  authorization**'dır; RLS ikinci katmandır. Dokümanda "veriler RLS ile
  korunuyor" gibi belirsiz bir ifade kullanma.
- **Veri metotlarına ham `userId` geçirme.** Arka uç metotları markalanmış
  `DataScope` alır. Kapsam yalnızca `ownScope(actor)` veya
  `adminScope(admin, targetId)` ile üretilir.
- **Normal kullanıcı uçları hedef kullanıcı kimliği kabul etmez.** Kimlik her
  zaman doğrulanmış oturumdan türetilir; gövde, sorgu veya route parametresinden
  ASLA okunmaz.
- **Başka kullanıcıyı hedefleyen işlemler `AdminService`'tedir** ve
  `requireCurrentAdmin()` zorunludur. Her erişim denetim kaydı üretir.
- Yeni bir API ucu eklerken `tests/authorization-matrix.test.ts` içindeki guard
  tablosunu da güncelle; aksi hâlde test başarısız olur.

## Guard seçimi

| Guard | Ne zaman |
| --- | --- |
| `requireAuthenticatedUser` | YALNIZCA `/api/auth/session`, `/logout`, `/logout-all`, `/change-password` |
| `requireUsableUser` | Kullanıcının kendi verisiyle ilgili her uç |
| `requireCurrentAdmin` | Yönetim uçları |

Geçici parolalı kullanıcı `requireUsableUser` ve `requireCurrentAdmin`
guard'larından **geçemez**; `PASSWORD_CHANGE_REQUIRED` ile reddedilir.
Arayüz yönlendirmesine tek başına güvenme.

## CSRF ve route sarmalayıcısı

- **Her API route'u `apiRoute()` ile sarılır.** Ham `export async function POST`
  yazma; sarmalayıcı hem CSRF/origin kontrolünü hem hata dönüşümünü yapar.
- Durum değiştiren isteklerde `Origin` + `Sec-Fetch-Site` + imzalı CSRF jetonu
  doğrulanır. İstemci tarafında `apiFetch()` kullan; ham `fetch` ile mutation
  yapma (jeton eklenmez).
- CSRF jetonunu `localStorage`/`sessionStorage`'a yazma. Jeton `<meta>` ile
  taşınır, eşi `HttpOnly` çerezdedir.

## Oturum modeli (tercihe bağlı: kalıcı / tarayıcı oturumu / admin)

- Giriş ekranında tek kutu: "Bu cihazda oturumumu açık tut" (`keepSignedIn`). İşaretli →
  kalıcı çerez + 180 gün kaydırmalı; işaretsiz → tarayıcı oturumu çerezi + 8 saat / 30 dk;
  admin → her zaman 8 saat / 15 dk, ASLA kalıcı değil (`sessionPolicyFor`).
- Tercihi tarayıcı deposuna yazma; oturum kaydındaki `persistent` alanı tek kaynaktır.
- Süre kontrolü **sunucudadır**; istemcide sayaç YOKTUR.
- 180 gün kaydırmalı ömür (`SESSION_ROLLING_LIFETIME_MS`); bitiş en fazla 24 saatte bir,
  `last_seen_at` en fazla 15 dakikada bir yazılır. Her istekte DB yazma.
- Oturum kimliği 7 günde bir `commitSessionCookie()` ile sessizce yenilenir; eski kimlik
  60 sn tolerans süresiyle kabul edilir. Hiç bitmeyen / hiç değişmeyen jeton üretme.
- Çerez kalıcıdır (`expires` = sunucudaki bitiş); `__Host-` öneki, HttpOnly, Secure, SameSite=Lax.
- Normal çıkış yalnızca mevcut oturumu siler; `logout-all` ve yönetici iptali hepsini.
  Çıkış uçlarında `markSessionEnded()` çağır ki istek sonunda çerez yeniden yazılmasın.
- `device_mode` ve `idle_expires_at` deprecated'dır; yetkilendirme kararında KULLANMA.
- Oturum kaydına ham IP, User-Agent veya parmak izi yazma; yalnızca `describeDevice()` etiketi.

## Hız sınırlayıcı ve istemci IP'si

- Üretimde **paylaşımlı (Postgres)** sınırlayıcı zorunludur. Yapılandırma
  eksikse bellek sınırlayıcısına **sessizce düşme**; açık yapılandırma hatası ver.
- Giriş üç sayaçtan geçer: IP, kullanıcı adı, IP+kullanıcı adı (`loginRateLimitBuckets`).
  Başarılı girişte yalnızca kombinasyon sayacını sıfırla.
- Anahtarı ham saklama; `RATE_LIMIT_PEPPER` ile HMAC'le. Ham IP hiçbir loga/tabloya yazılmaz.
- `X-Forwarded-For`'u doğrudan okuma; `resolveClientIp()` + `TRUSTED_PROXY_PROVIDER` kullan.
- Sınırlayıcı sorgusu hata verirse isteği geçirme (fail closed).
- Üretimde `APP_ORIGIN` zorunludur; Host başlığından origin türetme.

## Veritabanı değişiklikleri

- Mevcut migration dosyalarını **düzenleme**; yeni numaralı dosya ekle.
- Kısıt eklerken mevcut veriyle çakışma olup olmadığını önce kontrol et ve
  gerekiyorsa açık bir hata ile durdur.
- Finansal yazma yollarında aşırı satış kontrolü **atomik** olmalıdır
  (portföy satırı kilidi + aynı transaction içinde doğrulama).
- Denetim kayıtlarını değiştirilebilir hâle getirme; tetikleyici korumasını kaldırma.
- **Yeni SQL fonksiyonu eklerken yetkilerini açıkça ayarla:** tam imzayla `revoke all ... from
  public, anon, authenticated`; yalnızca BFF'nin çağıracağı üst seviye RPC'ye `grant execute ... to
  service_role`. Dahili yardımcı ve tetikleyici fonksiyonlarına hiçbir role grant verme.
- **anon/authenticated rollerine INSERT/UPDATE/DELETE grant'ı verme**; Data API yalnızca RLS
  kapsamlı SELECT içindir. Finansal mutation yalnızca BFF + `*_transaction_checked` RPC yoluyla.
- `GET` yolları veri OLUŞTURMAZ; varsayılan kayıtlar provisioning tetikleyicisi/onarımı ile hazırlanır.
- Politika ve grant değişikliğinden sonra `supabase/tests/rls.test.sql` planını güncelle ve
  `npm run test:db` çalıştır (yerel Supabase: `npx supabase start`).

## Muhasebe kuralları (ihlal edilemez)

- **Finansal hesapta `number` kullanma.** Miktar/tutar API'de ondalık DİZE, motorda
  `decimal.js` (`src/domain/accounting`), veritabanında `numeric`. `decimal.js`'te
  `isPositive()` sıfır için de true döner; `> 0` için `greaterThan(0)` kullan.
- **Defter kaynak gerçektir.** Kayıt silme/güncelleme yok; yalnızca `ledger_append`,
  `ledger_void`, `ledger_replace` RPC'leri. `portfolio_positions` projeksiyonuna elle yazma.
- **Her mutation `clientRequestId` kabul etsin;** aynı içerik replay, farklı içerik 409.
- Kullanıcının gerçek işlem fiyatı esastır; piyasa fiyatı maliyeti değiştirmez.
  `MARKET_BASELINE` fiyatını yalnızca sunucu sağlayıcısından al; istemci fiyatını yok say.
- Fiyat yok/bayat/geçersizse değerlemeyi hesaplanmış gibi gösterme; başka üründen tahmin yapma.
- "Hayat boyu toplam kâr", "kesin kâr", "vergiye esas kâr" ifadelerini kullanma.
- Motoru değiştirirsen `tests/accounting.test.ts`, pgTAP muhasebe bölümü ve
  `0010_accounting_rpc.sql` (`ledger_replay_product`) birlikte güncellenmeli;
  `npm run accounting:verify` ve `npm run accounting:smoke` (yerel Supabase) çalıştır.
- CLI betikleri (`admin:*`, `accounting:*`) `server-only` stub'ı ile çalışır
  (`scripts/node-server-only-stub.cjs`); uygulama kodunda bu stub'ı kullanma.

## Teslim paketi

- Build/cache dosyalarını depoya ekleme (`.next`, `node_modules`, `.data`,
  `dist`, `test-results`, tsbuildinfo).
- Kaynak paketi `npm run package:source` ile üretilir; komut secret taraması
  yapar ve iz bulursa paketi siler.

## Fiyat verisi kuralları

- **Gerçek fiyat entegrasyonunu lisans/izin olmadan scrape ederek yapma.** KAYSARDER, Sarraf TV veya
  başka bir siteden izinsiz veri çekme.
- Alış ve satış fiyatlarını birbirine çevirme, türetme veya yer değiştirme.
  `liquidationPrice` = piyasanın alışı (kullanıcının bozdurma karşılığı),
  `replacementPrice` = piyasanın satışı (kullanıcının yeniden alım maliyeti).
  Kullanıcının kendi işlem fiyatı bu ikisinden bağımsızdır ve maliyette esas olan odur.
- Bir sağlayıcı başarısız olduğunda başka piyasanın fiyatına **sessizce geçme**. Fiyat yoksa
  arayüzde "fiyat yok" gösterilir, sıfır gösterilmez.
- Test verisini gerçek piyasa verisi gibi etiketleme. `isRealMarketData: false` olan her kaynak
  arayüzde açıkça işaretlenir.
- Bayat veriye "güncel" deme.

## Arayüz kuralları

- **Türkçe UI metinlerinde yazım hatası bırakma.** Türkçe karakterleri doğru kullan
  (ı/i, ş, ğ, ü, ö, ç). Ekleri doğru yaz.
- Fotoğraf ve kişiye özel logo kullanma. Ürün adı `src/config/app.config.ts` dosyasından gelir;
  başka yerde sabit yazılmaz.
- Mobil öncelikli çalış. **390 px genişlikte yatay kaydırma oluşmamalıdır**; geniş içerik kendi
  `overflow-x: auto` kabında kaydırılır.
- Erişilebilirlik: yeterli kontrast, klavye ile kullanılabilirlik, `aria-*` etiketleri,
  görünür odak halkası. Rengi tek bilgi taşıyıcı yapma.
- Ürün kataloğu yalnızca `src/domain/catalog.ts` içinde tanımlanır; bileşenlere dağıtılmaz.

## Test kuralları

- Yeni iş kuralı eklerken karşılık gelen testi de ekle.
- Güvenlik yüzeyi denetimleri `tests/security-surface.test.ts` içindedir; bu testleri zayıflatarak
  geçirme, kodu düzelt.
- Testleri atlamak (`skip`) veya beklentiyi gevşetmek yerine kök nedeni çöz.

---

@AGENTS.md
