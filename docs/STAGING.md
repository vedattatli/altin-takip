# Staging Rehberi (Sprint 2)

Bu belge, uygulamanın **production olmayan** bir staging ortamına (ayrı Supabase projesi +
ayrı Vercel projesi) nasıl kurulacağını ve doğrulanacağını anlatır. Staging'de yalnızca
**test verisi** kullanılır; fiyatlar test sağlayıcısından gelir ve arayüz "Gerçek piyasa
verisi değil" uyarısını her zaman gösterir. Gerçek fiyat sağlayıcıları lisans olmadan
staging'de de açılmaz (bkz. [PRICE_PROVIDERS.md](PRICE_PROVIDERS.md)).

## 1. Kurallar

- Gerçek secretlar yalnızca `.env.staging.local` dosyasındadır: gitignore'dadır, kaynak
  ZIP'e girmez, betikler değerleri konsola **yazmaz** (yalnızca "var / EKSİK").
- `STAGING_ENVIRONMENT=staging` olmayan, `APP_ORIGIN`'i https/sabit olmayan, demo modu açık
  veya `NEXT_PUBLIC_` değişkenlerinde secret izi bulunan yapılandırmada araçlar **fail closed**
  davranır; hiçbir şey yapmaz.
- `SUPABASE_PRODUCTION_PROJECT_REF` verilmişse staging araçları o ref'e asla dokunmaz.
- Kimlik doğrulama (Supabase CLI, Vercel CLI, GitHub CLI) kullanıcı tarafından **interaktif**
  yapılır: `npx supabase login`, `npx vercel login`, `gh auth login`. Betikler token/parola
  istemez ve yazdırmaz.
- Test hesapları (`stagingusera`, `staginguserb`) rastgele parolayla oluşturulur; parolalar
  yalnızca `.staging/accounts.local.json` (gitignore, 0600) dosyasında tutulur. Yönetici
  bootstrap hesabı `npm run staging:admin` (güvenli `admin:create` akışı) ile açılır ve onay
  olmadan silinmez.

## 2. Komutlar

| Komut | Ne yapar |
| --- | --- |
| `npm run staging:doctor` | Node/npm, git ağacı, Supabase/Vercel CLI oturumları, zorunlu değişken ADLARI, APP_ORIGIN, demo modu, production dışı hedef, NEXT_PUBLIC_ secret taraması. Zorunlu kontrol düşerse çıkış 1 |
| `npm run staging:migrate` | Bağlı projenin STAGING ref'i olduğunu doğrular; `supabase db push --linked` ile 0001→son migration'ı uygular; `migration list --linked` ile geçmişi doğrular |
| `npm run staging:smoke` | Gerçek JWT'li Data API sondası (`SUPABASE_STAGING_JWT_SECRET` gerekir) + `accounting:verify`; service_role doğrudan yazma reddi, RPC'ler, cascade silme kanıtı |
| `npm run staging:seed` | User A / User B (geçici parola, ilk girişte değiştirme zorunlu) |
| `npm run staging:admin -- --username <ad> --display-name "<ad>"` | Yönetici (parola gizli girilir) |
| `npm run staging:cleanup` | Test kullanıcılarını ve verilerini siler (cascade); admin yalnızca `--include-admin` + `STAGING_CLEANUP_ADMIN_CONFIRM=<ad>` ile |
| `npm run test:staging` | `playwright.staging.config.ts` ile staging URL'sine karşı gerçek E2E (mobil 390 + masaüstü 1440); admin testleri için `STAGING_ADMIN_PASSWORD` ortam değişkeni (yalnızca o koşum) |

## 3. Sıra

1. `.env.staging.example` → `.env.staging.local`; Supabase staging projesi değerleri, Vercel
   staging URL'si (sabit alias), `openssl rand -base64 48` ile secretlar.
2. `npm run staging:doctor` (zorunlu kontroller geçmeli).
3. `npx supabase login` → `npx supabase link --project-ref <staging-ref>` → `npm run staging:migrate`.
4. `npm run staging:admin -- --username <ad> --display-name "<ad>"` → `npm run staging:seed`.
5. `npm run staging:smoke`.
6. Vercel: ayrı staging projesi, `APP_ORIGIN` = sabit staging URL'si (birebir), Supabase
   değerleri yalnızca doğru scope'larda (`SUPABASE_SECRET_KEY` hiçbir `NEXT_PUBLIC_` değişkene
   girmez), `TRUSTED_PROXY_PROVIDER=vercel`, demo modu kapalı. Uygulama zaten
   `robots: noindex, nofollow` ve güvenlik başlıklarını gönderir; `/api/*` yanıtları `no-store`.
7. Sprint 3 değişkenleri: `AUTH_MFA_ENCRYPTION_KEY` (32 bayt, yönetim uçları bunsuz açılmaz) ve
   `PRICE_CRON_SECRET` (boşsa alım ucu kapalıdır). Zamanlanmış alımı Vercel Cron veya harici
   zamanlayıcıyla `POST /api/cron/price-ingestion` + `X-Cron-Secret` başlığına bağlayın.
8. İlk yönetici girişinde ikinci faktör kurulumu zorunludur; kurtarma kodlarını güvenli bir
   yerde saklayın (bkz. [RUNBOOKS.md](RUNBOOKS.md) §4).
9. `STAGING_ADMIN_PASSWORD=<...> npm run test:staging`.
10. İş bitince `npm run staging:cleanup`.

## 4. Telefon–PC senkronizasyonu

- `portfolios.ledger_revision` yalnızca gerçek defter değişikliğinde (ekle / iptal / düzelt /
  toplu iptal) aynı transaction içinde artar; idempotent replay ve başarısız işlem artırmaz;
  elle değiştirilemez (tetikleyici). `GET /api/portfolio/version` (ETag/304, `no-store`)
  yalnızca oturumdaki kullanıcının sürümünü döner.
- İstemci sayfa görünür ve çevrimiçiyken ~9 sn'de bir sürüm kontrol eder; sekme arka
  plandayken durur; görünürlük/focus/online olaylarında hemen kontrol eder; tek istek
  (AbortController); hatada üstel geri çekilme + jitter; sürüm değişince defter + özet +
  portföy meta yeniden yüklenir. Hedef: ≤ 15 sn.

## 5. Beklemede: dış hesap girişi gerektiren adımlar

Sprint 2'nin **yerel** kapsamı tamamlandı ve commit edildi. Aşağıdaki adımlar dış hesap
kimlik doğrulaması gerektirdiği için **yapılmadı**; başarılı gibi raporlanmamıştır.

| Adım | Durum | Engel |
| --- | --- | --- |
| Uzak Supabase staging projesi + migration | Yapılmadı | `npx supabase login` oturumu yok |
| Staging Data API sondası + `accounting:verify` (uzak) | Yapılmadı | Aynı |
| Vercel staging projesi ve dağıtımı | Yapılmadı | Vercel CLI kurulu/oturumlu değil |
| Gerçek staging E2E (`npm run test:staging`) | Yapılmadı | Staging URL'si ve hesaplar yok |
| GitHub private repo push'u | Yapılmadı | `gh` jetonu geçersiz (keyring) |

Devam etmek için (kullanıcı, kendi terminalinde):

```bash
gh auth login
npx supabase login
npx vercel login
```

Sonra `.env.staging.example` → `.env.staging.local` doldurulur ve bu belgenin 3. bölümündeki
sıra izlenir. Hiçbir parola/jeton sohbete veya loglara yazılmaz; araçlar değerleri yazdırmaz.
