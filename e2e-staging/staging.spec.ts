import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * GERÇEK STAGING E2E — Vercel staging URL'si + Supabase staging projesi.
 *
 *   npm run test:staging
 *
 * Kimlik bilgileri .staging/accounts.local.json (gitignore) dosyasından okunur; loglara,
 * ekran görüntülerine veya rapora yazılmaz. Yönetici parolası STAGING_ADMIN_PASSWORD
 * ortam değişkeninden (yalnızca bu koşum için) alınır; dosyaya yazılmaz.
 *
 * Kapsam (§12): admin girişi ve kullanıcı listesi, ilk giriş parola değişikliği,
 * telefon–PC senkronizasyonu (≤15 sn), kullanıcı izolasyonu (B → A verisi yok, ID tahmini
 * 404), admin salt okunur portföy, admin oturum kapatma, parola sıfırlama ile oturum düşürme,
 * "tüm cihazlardan çıkış", kalıcı/kalıcı olmayan çerez, admin oturumunun kalıcı olmaması,
 * MARKET_BASELINE'ın yalnızca test fiyatıyla oluşması ve yatay taşma olmaması.
 */

const ACCOUNTS_FILE = ".staging/accounts.local.json";
const SESSION_COOKIE_SUFFIX = "altin_takip_session";
const SYNC_TIMEOUT = 15_000;

interface Account {
  username: string;
  temporaryPassword?: string;
  currentPassword?: string;
  mustChangePassword: boolean;
}
interface Accounts {
  admin?: { username: string };
  users: Account[];
}

function loadAccounts(): Accounts {
  if (!existsSync(ACCOUNTS_FILE)) throw new Error(`${ACCOUNTS_FILE} yok: önce npm run staging:seed`);
  return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as Accounts;
}
function saveAccounts(accounts: Accounts): void {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { encoding: "utf8", mode: 0o600 });
}
function passwordOf(account: Account): string {
  const password = account.currentPassword ?? account.temporaryPassword;
  if (!password) throw new Error(`${account.username} için parola bilinmiyor.`);
  return password;
}
function newPassword(seed: string): string {
  return `Kz${seed.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}7!${Date.now().toString(36)}Q`;
}

async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 45_000 });
}

async function login(page: Page, username: string, password: string, keepSignedIn = true) {
  await gotoReady(page, "/giris");
  await page.getByLabel("Kullanıcı adı").fill(username);
  await page.getByLabel("Parola", { exact: true }).fill(password);
  const keep = page.getByLabel(/oturumumu açık tut/);
  if ((await keep.isChecked()) !== keepSignedIn) await keep.click();
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/giris"), { timeout: 45_000 });
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 45_000 });
}

/** İlk giriş: geçici parola → yeni parola; hesap dosyası güncellenir. */
async function ensureUsablePassword(page: Page, accounts: Accounts, account: Account) {
  if (!account.mustChangePassword) return;
  await login(page, account.username, passwordOf(account));
  await page.waitForURL(/parola-degistir/, { timeout: 30_000 });
  const next = newPassword(account.username);
  await page.getByLabel("Mevcut parola").fill(passwordOf(account));
  await page.getByLabel("Yeni parola", { exact: true }).fill(next);
  await page.getByLabel("Yeni parola (tekrar)").fill(next);
  await page.getByRole("button", { name: /Parolayı değiştir|Kaydet/ }).click();
  await page.waitForURL((url) => !url.pathname.includes("parola-degistir"), { timeout: 30_000 });
  account.currentPassword = next;
  account.mustChangePassword = false;
  saveAccounts(accounts);
  await page.context().clearCookies();
}

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
      const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const parsed = (await response.json().catch(() => null)) as { data?: unknown; error?: string; code?: string } | null;
      return { status: response.status, data: (parsed?.data ?? null) as T | null, error: parsed?.error ?? null, code: parsed?.code ?? null };
    },
    { method, path, body: body ?? null },
  );
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function sessionCookie(context: BrowserContext) {
  return (await context.cookies()).find((cookie) => cookie.name.endsWith(SESSION_COOKIE_SUFFIX));
}

const accounts = loadAccounts();
const userA = accounts.users.find((user) => user.username === "stagingusera");
const userB = accounts.users.find((user) => user.username === "staginguserb");
const adminUsername = accounts.admin?.username;
const adminPassword = process.env.STAGING_ADMIN_PASSWORD ?? "";

test.describe("staging: hesaplar ve izolasyon", () => {
  test.skip(!userA || !userB, "staging:seed çalıştırılmamış");

  test("User A ilk girişte geçici parolasını değiştirir; User B de", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await ensureUsablePassword(page, accounts, userA!);
    await ensureUsablePassword(page, accounts, userB!);
    await context.close();
  });

  test("admin giriş yapar, User A ve B'yi görür; admin oturumu kalıcı değildir", async ({ page }) => {
    test.skip(!adminUsername || !adminPassword, "STAGING_ADMIN_PASSWORD verilmedi");
    await login(page, adminUsername!, adminPassword, true);
    await gotoReady(page, "/yonetim");
    await expect(page.getByRole("heading", { name: "Yönetim" })).toBeVisible();
    await expect(page.getByTestId("user-list")).toContainText("stagingusera");
    await expect(page.getByTestId("user-list")).toContainText("staginguserb");
    const cookie = await sessionCookie(page.context());
    expect(cookie).toBeDefined();
    expect(cookie!.expires).toBe(-1);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
  });

  test("kullanıcı A masaüstünde altın ekler; mobilde ≤15 sn görünür; mobil iptal masaüstüne düşer; B görmez", async ({ browser }) => {
    test.setTimeout(180_000);
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const other = await browser.newContext();
    try {
      const desktopPage = await desktop.newPage();
      const mobilePage = await mobile.newPage();
      const otherPage = await other.newPage();
      await login(desktopPage, userA!.username, passwordOf(userA!));
      await login(mobilePage, userA!.username, passwordOf(userA!));
      await login(otherPage, userB!.username, passwordOf(userB!));

      // Temiz başlangıç: A'nın aktif kayıtları iptal edilir (test verisi).
      await gotoReady(desktopPage, "/panel");
      await api(desktopPage, "DELETE", "/api/transactions");
      await gotoReady(mobilePage, "/panel");
      await expect(mobilePage.getByTestId("sync-status")).toBeVisible();

      await gotoReady(desktopPage, "/islemler");
      await desktopPage.getByTestId("add-buy").click();
      await desktopPage.getByLabel(/^Miktar/).fill("3");
      await desktopPage.getByLabel(/^Birim alış fiyatı/).fill("5000");
      await desktopPage.getByTestId("submit-buy").click();
      await expect(desktopPage.getByTestId("transaction-list")).toBeVisible();

      await expect(mobilePage.getByTestId("stat-cost")).toContainText("15.000,00", { timeout: SYNC_TIMEOUT });
      await noHorizontalOverflow(mobilePage);

      await gotoReady(desktopPage, "/panel");
      await gotoReady(mobilePage, "/islemler");
      await mobilePage.getByRole("button", { name: "İptal et" }).first().click();
      await mobilePage.getByTestId("confirm-void").click();
      await expect(mobilePage.getByTestId("transaction-list")).toContainText("İptal edildi");
      await expect(desktopPage.getByTestId("stat-cost")).toContainText("0,00", { timeout: SYNC_TIMEOUT });
      await noHorizontalOverflow(desktopPage);

      // B, A'nın verisini göremez; A'nın kayıt kimliğiyle işlem yapamaz.
      const aLedger = await api<{ id: string }[]>(desktopPage, "GET", "/api/transactions");
      const aEntryId = aLedger.data?.[0]?.id;
      const bLedger = await api<unknown[]>(otherPage, "GET", "/api/transactions");
      expect(bLedger.data).toEqual([]);
      if (aEntryId) {
        const guess = await api(otherPage, "DELETE", `/api/transactions/${aEntryId}`, { reason: "x" });
        expect(guess.status).toBe(404);
      }

      // MARKET_BASELINE yalnızca test fiyatıyla; "Gerçek piyasa verisi değil" görünür.
      await gotoReady(desktopPage, "/islemler?ekle=mevcut");
      await desktopPage.getByLabel(/^Miktar/).fill("1");
      await desktopPage.getByTestId("opening-next").click();
      await desktopPage.getByTestId("cost-method-MARKET_BASELINE").click();
      await desktopPage.getByTestId("opening-next").click();
      await expect(desktopPage.getByTestId("baseline-confirm")).toContainText("Test verisi");
      await desktopPage.getByTestId("submit-opening").click();
      await expect(desktopPage.getByTestId("transaction-list")).toContainText("Takip başlangıç değeri");
      await gotoReady(desktopPage, "/panel");
      await expect(desktopPage.getByTestId("price-source")).toContainText("Gerçek piyasa verisi değil");
      await noHorizontalOverflow(desktopPage);
    } finally {
      await desktop.close();
      await mobile.close();
      await other.close();
    }
  });

  test("admin A'nın portföyünü salt okunur görür ve A'nın defterini değiştiremez; oturum kapatma A'yı düşürür", async ({ browser }) => {
    test.skip(!adminUsername || !adminPassword, "STAGING_ADMIN_PASSWORD verilmedi");
    const adminContext = await browser.newContext();
    const userContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      const userPage = await userContext.newPage();
      await login(userPage, userA!.username, passwordOf(userA!));
      await login(adminPage, adminUsername!, adminPassword);

      const users = await api<{ id: string; username: string }[]>(adminPage, "GET", "/api/admin/users?q=stagingusera");
      const target = users.data?.find((user) => user.username === "stagingusera");
      expect(target).toBeDefined();
      const portfolio = await api<{ canEdit: boolean; ledger: unknown[] }>(adminPage, "GET", `/api/admin/users/${target!.id}/portfolio`);
      expect(portfolio.status).toBe(200);
      expect(portfolio.data?.canEdit).toBe(false);
      const before = portfolio.data?.ledger.length ?? 0;
      // Admin'in kendi işlem ucu A'nın defterine yazamaz; A'nın kayıt sayısı değişmez.
      await api(adminPage, "POST", "/api/transactions", { kind: "BUY", productId: "gram-altin", quantity: "1", occurredAt: "2026-01-10", pricingInputMode: "UNIT_PRICE", unitPrice: "5000" });
      const after = await api<{ ledger: unknown[] }>(adminPage, "GET", `/api/admin/users/${target!.id}/portfolio`);
      expect(after.data?.ledger.length ?? 0).toBe(before);
      await api(adminPage, "DELETE", "/api/transactions");

      // Admin A'nın oturumlarını kapatır → A'nın erişimi kesilir.
      const revoke = await api(adminPage, "DELETE", `/api/admin/users/${target!.id}/sessions`);
      expect(revoke.status).toBe(200);
      const denied = await api(userPage, "GET", "/api/portfolio");
      expect(denied.status).toBe(401);
    } finally {
      await adminContext.close();
      await userContext.close();
    }
  });

  test("parola sıfırlama diğer oturumları düşürür; 'tüm cihazlardan çıkış' çalışır; kalıcı olmayan çerez", async ({ browser }) => {
    test.setTimeout(150_000);
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const firstPage = await first.newPage();
      const secondPage = await second.newPage();
      await login(firstPage, userB!.username, passwordOf(userB!), true);
      await login(secondPage, userB!.username, passwordOf(userB!), false);

      const persistent = await sessionCookie(first);
      const transient = await sessionCookie(second);
      expect(persistent!.expires).toBeGreaterThan(Date.now() / 1000 + 24 * 3600);
      expect(transient!.expires).toBe(-1);

      // Tüm cihazlardan çıkış (ikinci cihazdan): birinci de düşer.
      await gotoReady(secondPage, "/ayarlar");
      await secondPage.getByTestId("open-logout-all").click();
      await secondPage.getByTestId("confirm-logout-all").click();
      await secondPage.waitForURL(/giris/, { timeout: 30_000 });
      const firstDenied = await api(firstPage, "GET", "/api/portfolio");
      expect(firstDenied.status).toBe(401);

      // Kalıcı oturum: bağlam yeniden açıldığında (çerezler taşınır) oturum korunur.
      await login(firstPage, userB!.username, passwordOf(userB!), true);
      const state = await first.storageState();
      const reopened = await browser.newContext({ storageState: state });
      const reopenedPage = await reopened.newPage();
      await gotoReady(reopenedPage, "/panel");
      expect((await api(reopenedPage, "GET", "/api/portfolio")).status).toBe(200);
      await reopened.close();

      // Kullanıcının kendi parola değişikliği diğer cihazı düşürür.
      const next = newPassword(userB!.username);
      const changed = await api(firstPage, "POST", "/api/auth/change-password", { currentPassword: passwordOf(userB!), newPassword: next });
      expect(changed.status).toBe(200);
      userB!.currentPassword = next;
      saveAccounts(accounts);
      await login(secondPage, userB!.username, next, false);
      expect((await api(secondPage, "GET", "/api/portfolio")).status).toBe(200);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
