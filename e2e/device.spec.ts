import { expect, test } from "@playwright/test";

import {
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  login,
  scopedUsername,
} from "./helpers";

/**
 * Üretimde çerez adı __Host- öneklidir (Secure + Path=/ + Domain'siz zorunlu).
 * Test her iki adı da tanısın diye sonek eşleşmesi kullanılır.
 */
const SESSION_COOKIE_SUFFIX = "altin_takip_session";

async function sessionCookie(context: import("@playwright/test").BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name.endsWith(SESSION_COOKIE_SUFFIX));
}

test.describe("cihaz türü seçimi", () => {
  test("giriş ekranı kişisel ve ortak cihaz seçeneği sunar", async ({ page }) => {
    await gotoReady(page, "/giris");

    await expect(page.getByRole("radio", { name: "Kişisel cihaz" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Şirket / ortak cihaz" })).toBeVisible();

    // Güvenli varsayılan: ortak cihaz seçili gelir.
    await expect(page.getByRole("radio", { name: "Şirket / ortak cihaz" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // "Beni hatırla" kutusu YOKTUR.
    await expect(page.getByLabel(/beni hatırla/i)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("ortak cihazda oturum çerezi kalıcı değildir", async ({ page, context }) => {
    const username = scopedUsername("ortakcihaz");
    await createReadyUser(username);

    await login(page, username, undefined, "shared");
    await page.waitForURL("**/panel");

    const cookie = await sessionCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    // Oturum çerezi: son kullanma tarihi yok (Playwright bunu -1 olarak bildirir).
    expect(cookie?.expires).toBe(-1);
  });

  test("kişisel cihazda oturum çerezi kalıcıdır", async ({ page, context }) => {
    const username = scopedUsername("kisiselcihaz");
    await createReadyUser(username);

    await login(page, username, undefined, "personal");
    await page.waitForURL("**/panel");

    const cookie = await sessionCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);
  });

  test("ortak cihazda hareketsizlik sonrası otomatik çıkış yapılır", async ({ page }) => {
    const username = scopedUsername("zamanasimi");
    await createReadyUser(username);

    await login(page, username, undefined, "shared");
    await page.waitForURL("**/panel");

    // Test ortamında hareketsizlik süresi 5 saniyeye indirilmiştir.
    await page.waitForURL("**/giris?sebep=zaman-asimi", { timeout: 30_000 });
    await expect(page.getByText(/Hareketsizlik nedeniyle oturumunuz/)).toBeVisible();

    // Oturum gerçekten kapanmıştır.
    await gotoReady(page, "/panel");
    await page.waitForURL("**/giris");
  });

  test("ortak cihazda servis çalışanı kaydedilmez ve önbellek bırakılmaz", async ({ page }) => {
    const username = scopedUsername("swkontrol");
    await createReadyUser(username);

    await login(page, username, undefined, "shared");
    await page.waitForURL("**/panel");

    const state = await page.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      caches: (await caches.keys()).length,
      localStorageKeys: Object.keys(localStorage).length,
    }));

    expect(state.registrations).toBe(0);
    expect(state.caches).toBe(0);
    // Portföy ve oturum bilgisi JavaScript'ten okunabilir depoya yazılmaz.
    expect(state.localStorageKeys).toBe(0);
  });

  test("oturum jetonu JavaScript'ten okunamaz", async ({ page }) => {
    const username = scopedUsername("httponly");
    await createReadyUser(username);

    await login(page, username, undefined, "personal");
    await page.waitForURL("**/panel");

    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain(SESSION_COOKIE_SUFFIX);
  });

  test("kurulu PWA olmadan tüm ekranlar çalışır", async ({ page }) => {
    const username = scopedUsername("pwasiz");
    await createReadyUser(username);

    await login(page, username, undefined, "personal");
    await page.waitForURL("**/panel");

    // Servis çalışanı geliştirme ortamında hiç kaydedilmez; uygulama yine de tam çalışır.
    for (const path of ["/panel", "/islemler", "/ayarlar"]) {
      await gotoReady(page, path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});
