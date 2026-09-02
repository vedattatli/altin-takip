import { expect, test } from "@playwright/test";

import { ADMIN } from "./global-setup";
import {
  ageSessionsOnServer,
  browserApi,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  login,
  loginAsUser,
  readSessionExpiries,
  scopedUsername,
} from "./helpers";

/**
 * KALICI OTURUM MODELİ — gerçek tarayıcıda, üretim derlemesine karşı.
 *
 * Kullanıcı her cihazda bir kez giriş yapar; oturum siz çıkış yapana kadar
 * açık kalır. Cihaz türü sorulmaz, hareketsizlik zaman aşımı yoktur.
 */

const SESSION_COOKIE_SUFFIX = "altin_takip_session";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function sessionCookie(context: import("@playwright/test").BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name.endsWith(SESSION_COOKIE_SUFFIX));
}

test.describe("giriş ekranı", () => {
  test("cihaz türü sormaz; yalnızca 'oturumumu açık tut' kutusu vardır (varsayılan işaretsiz)", async ({ page }) => {
    await gotoReady(page, "/giris");

    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByText(/ortak cihaz/i)).toHaveCount(0);
    await expect(page.getByLabel(/beni hatırla/i)).toHaveCount(0);
    const keep = page.getByLabel(/oturumumu açık tut/);
    await expect(keep).toBeVisible();
    await expect(keep).not.toBeChecked();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("kalıcı oturum çerezi", () => {
  test("'oturumu açık tut' işaretsizse kalıcı çerez oluşmaz (tarayıcı oturumu)", async ({ page, context }) => {
    const username = scopedUsername("gecicicerez");
    await createReadyUser(username);
    await loginAsUser(page, username, undefined, { keepSignedIn: false });

    const cookie = await sessionCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    // Oturum çerezi: son kullanma tarihi yok (Playwright -1 bildirir).
    expect(cookie?.expires).toBe(-1);

    const session = await browserApi<{ user: { username: string }; persistent: boolean }>(
      page,
      "GET",
      "/api/auth/session",
    );
    expect(session.data?.persistent).toBe(false);
  });

  test("yönetici oturumu işaretli olsa bile kalıcı olmaz", async ({ page, context }) => {
    await login(page, ADMIN.username, ADMIN.password, { keepSignedIn: true });
    await page.waitForURL("**/panel");
    const cookie = await sessionCookie(context);
    expect(cookie?.expires).toBe(-1);
    const session = await browserApi<{ persistent: boolean }>(page, "GET", "/api/auth/session");
    expect(session.data?.persistent).toBe(false);
  });

  test("işaretliyse çerez kalıcı, HttpOnly ve SameSite=Lax'tır", async ({ page, context }) => {
    const username = scopedUsername("kalicicerez");
    await createReadyUser(username);
    await loginAsUser(page, username, undefined, { keepSignedIn: true });

    const cookie = await sessionCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    // Son kullanma tarihi ~180 gün sonrasıdır (oturum çerezi DEĞİLDİR).
    expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 170 * 24 * 60 * 60);
  });

  test("tarayıcı kapatılıp yeniden açıldığında oturum devam eder", async ({ browser }) => {
    const username = scopedUsername("yenidenacilis");
    await createReadyUser(username);

    const first = await browser.newContext();
    const page = await first.newPage();
    await loginAsUser(page, username, undefined, { keepSignedIn: true });
    // Kalıcı çerezler (oturum çerezleri değil) tarayıcı kapanınca korunur.
    const state = await first.storageState();
    await first.close();

    const restored = state.cookies.filter((cookie) => cookie.expires > 0);
    const second = await browser.newContext({ storageState: { cookies: restored, origins: [] } });
    const reopened = await second.newPage();
    await gotoReady(reopened, "/panel");
    await expect(reopened).toHaveURL(/\/panel$/);

    const session = await browserApi<{ user: { username: string } }>(
      reopened,
      "GET",
      "/api/auth/session",
    );
    expect(session.data?.user.username).toBe(username);
    await second.close();
  });

  test("oturum kimliği JavaScript'ten okunamaz ve tarayıcı deposunda yoktur", async ({ page }) => {
    const username = scopedUsername("httponly");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const state = await page.evaluate(async () => ({
      cookie: document.cookie,
      localStorageKeys: Object.keys(localStorage).length,
      sessionStorageKeys: Object.keys(sessionStorage).length,
      databases:
        typeof indexedDB.databases === "function" ? (await indexedDB.databases()).length : 0,
    }));

    expect(state.cookie).not.toContain(SESSION_COOKIE_SUFFIX);
    expect(state.localStorageKeys).toBe(0);
    expect(state.sessionStorageKeys).toBe(0);
    expect(state.databases).toBe(0);
  });
});

test.describe("hareketsizlik ve kaydırmalı yenileme", () => {
  test("15 dk, 1 saat ve 24 saat hareketsizlik kullanıcıyı çıkarmaz", async ({ page }) => {
    const username = scopedUsername("hareketsiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    for (const idle of [15 * MINUTE, HOUR, DAY]) {
      expect(await ageSessionsOnServer(username, idle)).toBeGreaterThan(0);
      const response = await browserApi(page, "GET", "/api/portfolio");
      expect(response.status, `${idle / MINUTE} dk`).toBe(200);
    }

    await gotoReady(page, "/panel");
    await expect(page).toHaveURL(/\/panel$/);
  });

  test("uzun aradan sonra bitiş zamanı sessizce ileri alınır", async ({ page }) => {
    const username = scopedUsername("kaydirmali");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const [before] = await readSessionExpiries(username);
    await ageSessionsOnServer(username, 2 * DAY);

    const response = await browserApi(page, "GET", "/api/portfolio");
    expect(response.status).toBe(200);

    const [after] = await readSessionExpiries(username);
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
  });

  test("her API çağrısı veritabanına yazmaz", async ({ page }) => {
    const username = scopedUsername("yazmaz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const [before] = await readSessionExpiries(username);
    for (let index = 0; index < 5; index += 1) {
      expect((await browserApi(page, "GET", "/api/portfolio")).status).toBe(200);
    }
    const [after] = await readSessionExpiries(username);
    // Yeni açılmış oturumda ardışık istekler bitiş zamanını değiştirmez.
    expect(after).toBe(before);
  });
});

test.describe("çıkış davranışı", () => {
  test("normal çıkış yalnızca bu cihazı kapatır", async ({ page, browser }) => {
    const username = scopedUsername("tekcihaz");
    await createReadyUser(username);

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneContext.newPage();
    await loginAsUser(phone, username);

    await loginAsUser(page, username);
    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");

    // Telefon oturumu açık kalır.
    const response = await browserApi(phone, "GET", "/api/portfolio");
    expect(response.status).toBe(200);
    await phoneContext.close();
  });

  test("'Tüm cihazlardan çıkış' bütün oturumları kapatır", async ({ page, browser }) => {
    const username = scopedUsername("tumcihaz");
    await createReadyUser(username);

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneContext.newPage();
    await loginAsUser(phone, username);

    await loginAsUser(page, username);
    await gotoReady(page, "/ayarlar");
    await page.getByTestId("open-logout-all").click();
    await page.getByTestId("confirm-logout-all").click();
    await page.waitForURL("**/giris");

    const response = await browserApi(phone, "GET", "/api/portfolio");
    expect(response.status).toBe(401);
    await phoneContext.close();
  });
});

test.describe("güvenlik olayları bütün cihazları kapatır", () => {
  test("yönetici parola sıfırlaması", async ({ page, browser }) => {
    const username = scopedUsername("oturumsifirla");
    const user = await createReadyUser(username);

    const deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await loginAsUser(device, username);

    await login(page, ADMIN.username, ADMIN.password);
    await page.waitForURL("**/panel");
    const reset = await browserApi(page, "POST", `/api/admin/users/${user.id}/password`, {
      temporaryPassword: "GeciciParola7Kasa",
    });
    expect(reset.status).toBe(200);

    expect((await browserApi(device, "GET", "/api/portfolio")).status).toBe(401);
    await deviceContext.close();
  });

  test("kullanıcı pasifleştirme", async ({ page, browser }) => {
    const username = scopedUsername("pasiflestirme");
    const user = await createReadyUser(username);

    const deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await loginAsUser(device, username);

    await login(page, ADMIN.username, ADMIN.password);
    await page.waitForURL("**/panel");
    const patched = await browserApi(page, "PATCH", `/api/admin/users/${user.id}`, {
      status: "inactive",
    });
    expect(patched.status).toBe(200);

    expect((await browserApi(device, "GET", "/api/portfolio")).status).toBe(401);
    await deviceContext.close();
  });

  test("yönetici panelinden oturumları görüp kapatma", async ({ page, browser }) => {
    const username = scopedUsername("oturumlistesi");
    const user = await createReadyUser(username);

    const deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await loginAsUser(device, username);

    await login(page, ADMIN.username, ADMIN.password);
    await page.waitForURL("**/panel");
    await gotoReady(page, `/yonetim/${user.id}`);

    const list = page.getByTestId("admin-session-list");
    await expect(list).toBeVisible();
    await expect(list.locator("li")).toHaveCount(1);
    // Ham IP gösterilmez; yalnızca kaba cihaz etiketi.
    await expect(list).not.toContainText(/\d+\.\d+\.\d+\.\d+/);

    await page.getByTestId("revoke-all-sessions").click();
    await expect(page.getByText("Açık oturum yok.")).toBeVisible();

    expect((await browserApi(device, "GET", "/api/portfolio")).status).toBe(401);
    await deviceContext.close();
  });
});

test.describe("cihazlar arası aynı portföy", () => {
  test("masaüstünde eklenen işlem mobil görünümde de görünür", async ({ page, browser }) => {
    const username = scopedUsername("ayniportfoy");
    await createReadyUser(username);

    await loginAsUser(page, username);
    const created = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "3",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
      clientRequestId: `req-e2e-${username}-1`,
    });
    expect(created.status).toBe(201);

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobile = await mobileContext.newPage();
    await loginAsUser(mobile, username);
    const listed = await browserApi<{ productId: string }[]>(mobile, "GET", "/api/transactions");
    expect(listed.data).toHaveLength(1);
    expect(listed.data?.[0]?.productId).toBe("gram-altin");

    await gotoReady(mobile, "/islemler");
    await expect(mobile.getByTestId("transaction-list")).toBeVisible();
    await expectNoHorizontalOverflow(mobile);
    await mobileContext.close();
  });

  test("kurulu PWA olmadan tüm ekranlar çalışır", async ({ page }) => {
    const username = scopedUsername("pwasiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    for (const path of ["/panel", "/islemler", "/ayarlar"]) {
      await gotoReady(page, path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});
