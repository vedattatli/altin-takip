import { expect, test, type Page } from "@playwright/test";

import { LocalAuthBackend } from "../src/server/auth/local-backend";
import { E2E_MFA_ENCRYPTION_KEY } from "./test-env";
import { decryptStoredSecret, totpCode } from "./totp";
import { E2E_STORE_FILE } from "./global-setup";

export const TEST_PASSWORD = "Kuyumcu7Defter";

/**
 * Testler üç ekran genişliği için sırayla çalışır ve aynı yerel veri dosyasını
 * paylaşır. Kullanıcı adına proje adı eklenerek her koşum kendi hesabını kullanır.
 */
export function scopedUsername(base: string): string {
  return `${base}.${test.info().project.name}`;
}

function backend(): LocalAuthBackend {
  return new LocalAuthBackend({ fileName: E2E_STORE_FILE });
}

/** Test için hazır (parola değiştirme zorunluluğu kaldırılmış) kullanıcı oluşturur. */
export async function createReadyUser(username: string, displayName = "Test Kullanıcı") {
  const store = backend();
  const existing = await store.findProfileByUsername(username);
  if (existing) return existing;

  const user = await store.createUser({
    username,
    displayName,
    temporaryPassword: TEST_PASSWORD,
    role: "user",
  });
  return store.setMustChangePassword(user.id, false);
}

/** Geçici parolalı (ilk girişte parola değiştirmesi gereken) kullanıcı oluşturur. */
export async function createPendingUser(username: string, displayName = "Yeni Kullanıcı") {
  const store = backend();
  const existing = await store.findProfileByUsername(username);
  if (existing) return existing;
  return store.createUser({
    username,
    displayName,
    temporaryPassword: TEST_PASSWORD,
    role: "user",
  });
}

/**
 * Sayfaya gider ve istemci tarafı etkileşim hazır olana kadar bekler.
 * Kök öğedeki data-hydrated işareti HydrationMarker tarafından yazılır.
 */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
}

export interface LoginOptions {
  /** "Bu cihazda oturumumu açık tut" kutusu. Varsayılan: işaretli (testlerin çoğu kalıcı oturum bekler). */
  keepSignedIn?: boolean;
}

/** Giriş yapar. Cihaz türü sorulmaz; yalnızca "oturumu açık tut" tercihi vardır. */
export async function login(
  page: Page,
  username: string,
  password = TEST_PASSWORD,
  options: LoginOptions = {},
) {
  await gotoReady(page, "/giris");
  await page.getByLabel("Kullanıcı adı").fill(username);
  await page.getByLabel("Parola", { exact: true }).fill(password);
  const keep = page.getByLabel(/oturumumu açık tut/);
  if (options.keepSignedIn ?? true) await keep.check();
  else await keep.uncheck();
  await page.getByRole("button", { name: "Giriş yap" }).click();
}

/**
 * Yönetici girişi + ikinci faktör.
 *
 * Yönetim paneli MFA olmadan açılmaz. İlk girişte kurulum yapılır (secret yanıtta
 * döner ve testte TOTP kodu hesaplanır), sonraki girişlerde yalnızca doğrulama.
 * Secret test süreci belleğinde tutulur; dosyaya veya log'a yazılmaz.
 */
/**
 * YÖNETİCİ GİRİŞİ (ikinci faktör dâhil)
 *
 * Giriş sonrası yönlendirme istemci tarafında bir adım gecikebildiği için URL'e
 * BAKILMAZ: durum her zaman /guvenlik sayfası açılarak belirlenir.
 *
 * Anahtar kaynağı iki yerden gelir ve süreç yeniden başlasa da kaybolmaz:
 *  - ilk kurulumda ekrandaki anahtar okunur,
 *  - kurulum daha önce yapıldıysa yerel depodaki şifreli anahtar çözülür.
 */
const adminSecrets = new Map<string, string>();

async function storedAdminSecret(username: string): Promise<string | null> {
  const cached = adminSecrets.get(username);
  if (cached) return cached;
  const store = backend();
  const profile = await store.findProfileByUsername(username);
  if (!profile) return null;
  const credential = await store.getMfaCredential(profile.id);
  if (!credential) return null;
  const secret = decryptStoredSecret(
    credential.secretCiphertext,
    credential.secretNonce,
    E2E_MFA_ENCRYPTION_KEY,
  );
  adminSecrets.set(username, secret);
  return secret;
}

export async function loginAsAdmin(
  page: Page,
  username: string,
  password: string,
  options: LoginOptions = {},
) {
  await login(page, username, password, options);
  await page.waitForURL(/giris|guvenlik|yonetim|panel/, { timeout: 30_000 });

  await gotoReady(page, "/guvenlik");
  const view = page.getByTestId("mfa-view");
  if (await view.isVisible().catch(() => false)) {
    const start = page.getByTestId("mfa-start");
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      const secret = (await page.getByTestId("mfa-secret").innerText()).trim();
      adminSecrets.set(username, secret);
    }
    const secret = (await storedAdminSecret(username)) ?? adminSecrets.get(username) ?? null;
    if (!secret) {
      throw new Error(`Yönetici ${username} için TOTP anahtarı bulunamadı; kurulum ekranı da açılmadı.`);
    }
    await page.getByTestId("mfa-code").fill(totpCode(secret, Date.now()));
    await page.getByTestId("mfa-submit").click();
    await page.waitForURL((url) => !url.pathname.startsWith("/guvenlik"), { timeout: 30_000 });
    await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
  }

  // Testler yönetici oturumunu panelden başlatır.
  if (!page.url().includes("/panel")) await gotoReady(page, "/panel");
}

export async function loginAsUser(
  page: Page,
  username: string,
  password = TEST_PASSWORD,
  options: LoginOptions = {},
) {
  await login(page, username, password, options);
  await page.waitForURL("**/panel");
}

/** Sayfada yatay taşma olmadığını doğrular. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(
    overflow.scrollWidth,
    `Yatay taşma: scrollWidth=${overflow.scrollWidth}, viewport=${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Yeni bir alış işlemi ekler (İşlemler sayfasında olmalı). */
export async function addPurchase(
  page: Page,
  options: { product?: string; quantity: string; unitPrice: string; workmanship?: string; fees?: string },
) {
  await page.getByTestId("add-buy").click();
  if (options.product) {
    await page.getByLabel("Altın türü").selectOption({ label: options.product });
  }
  await page.getByLabel(/^Miktar/).fill(options.quantity);
  await page.getByLabel(/^Birim alış fiyatı/).fill(options.unitPrice);
  if (options.workmanship) await page.getByLabel(/^İşçilik/).fill(options.workmanship);
  if (options.fees) await page.getByLabel(/^Komisyon/).fill(options.fees);
  await page.getByTestId("submit-buy").click();
  await expect(page.getByTestId("transaction-list")).toBeVisible();
}

/** Satış işlemi ekler (İşlemler sayfasında olmalı). */
export async function addSale(
  page: Page,
  options: { product?: string; quantity: string; unitPrice: string; fees?: string },
) {
  await page.getByTestId("add-sell").click();
  if (options.product) {
    await page.getByLabel("Altın türü").selectOption({ label: options.product });
  }
  await page.getByLabel(/^Miktar/).fill(options.quantity);
  await page.getByLabel(/^Birim satış fiyatı/).fill(options.unitPrice);
  if (options.fees) await page.getByLabel(/^Satış masrafı/).fill(options.fees);
  await page.getByTestId("submit-sell").click();
}

export interface BrowserApiResult<T = unknown> {
  status: number;
  /** Başarılı yanıtın { data } içeriği. */
  data: T | null;
  /** Hata yanıtının mesajı ve kodu. */
  error: string | null;
  code: string | null;
}

/**
 * API isteğini TARAYICI İÇİNDEN yapar.
 *
 * Playwright'ın `page.request` istemcisi Node tarafında çalışır ve `Secure`
 * işaretli oturum çerezini düz HTTP üzerinden göndermez. Ayrıca durum
 * değiştiren istekler CSRF jetonu ister; jeton sayfadaki meta etiketindedir.
 */
export async function browserApi<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  options: { csrf?: "auto" | "omit" | "invalid" } = {},
): Promise<BrowserApiResult<T>> {
  return page.evaluate(
    async ({ method, path, body, csrf }) => {
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";

      if (csrf !== "omit") {
        const token =
          document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
        headers["X-CSRF-Token"] = csrf === "invalid" ? "gecersiz-jeton" : token;
      }

      const response = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = (await response.json().catch(() => null)) as
        | { data?: unknown; error?: string; code?: string }
        | null;

      return {
        status: response.status,
        data: parsed?.data ?? null,
        error: parsed?.error ?? null,
        code: parsed?.code ?? null,
      };
    },
    { method, path, body: body ?? null, csrf: options.csrf ?? "auto" },
  ) as Promise<BrowserApiResult<T>>;
}

interface StoredSessionShape {
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
  renewedAt: string;
  rotatedAt: string;
}

async function mutateSessions(
  username: string,
  mutate: (session: StoredSessionShape) => void,
): Promise<number> {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const file = join(process.cwd(), ".data", E2E_STORE_FILE);
  if (!existsSync(file)) return 0;

  const store = JSON.parse(readFileSync(file, "utf8")) as {
    users: { id: string; username: string }[];
    sessions: StoredSessionShape[];
  };

  const user = store.users.find((candidate) => candidate.username === username);
  if (!user) return 0;

  let touched = 0;
  for (const session of store.sessions) {
    if (session.userId !== user.id) continue;
    mutate(session);
    touched += 1;
  }

  writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
  return touched;
}

/**
 * Kullanıcının tüm oturumlarını SUNUCU TARAFINDA süresi geçmiş hâle getirir
 * (180 günlük kaydırmalı ömrün dolduğu durumu simüle eder).
 */
export async function expireSessionsOnServer(username: string): Promise<number> {
  const past = new Date(Date.now() - 60_000).toISOString();
  return mutateSessions(username, (session) => {
    session.expiresAt = past;
  });
}

/** Kullanıcının tüm oturumlarını sunucuda iptal edilmiş (revoke) olarak işaretler. */
export async function revokeSessionsOnServer(username: string): Promise<number> {
  const now = new Date().toISOString();
  return mutateSessions(username, (session) => {
    session.revokedAt = now;
  });
}

/**
 * Kullanıcının oturumlarını "uzun süredir kullanılmıyor" hâline getirir: son
 * görülme ve yenileme zamanları geçmişe alınır, bitiş zamanı DEĞİŞMEZ.
 * Böylece 15 dk / 1 saat / 24 saat hareketsizliğin oturumu düşürmediği ve
 * kaydırmalı yenilemenin çalıştığı gerçek sunucuda doğrulanabilir.
 */
export async function ageSessionsOnServer(username: string, idleMs: number): Promise<number> {
  const past = new Date(Date.now() - idleMs).toISOString();
  return mutateSessions(username, (session) => {
    session.lastSeenAt = past;
    session.renewedAt = past;
  });
}

/** Kullanıcının oturum bitiş zamanlarını okur (kaydırmalı yenileme kontrolü için). */
export async function readSessionExpiries(username: string): Promise<string[]> {
  const expiries: string[] = [];
  await mutateSessions(username, (session) => {
    expiries.push(session.expiresAt);
  });
  return expiries;
}
