import { expect, test, type BrowserContext } from "@playwright/test";

import {
  addPurchase,
  browserApi,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  loginAsUser,
  scopedUsername,
} from "./helpers";

/**
 * TELEFON–PC SENKRONİZASYONU (revision polling)
 *
 * Aynı kullanıcı bir 390×844 mobil ve bir 1440×900 masaüstü bağlamında açıktır.
 * Bir cihazda yapılan finansal değişiklik, sayfa yenilenmeden diğer cihazda en geç
 * 15 saniyede görünür. Başka kullanıcı (B) hiçbir değişikliği göremez.
 */

const SYNC_TIMEOUT = 15_000;

test.describe("telefon–PC senkronizasyonu", () => {
  test("masaüstünde eklenen alış mobilde, mobilde yapılan iptal masaüstünde ≤15 sn içinde görünür; User B etkilenmez", async ({ browser }) => {
    test.skip(test.info().project.name !== "masaustu-1440", "Kendi bağlamlarını açar; tek projede koşar.");
    test.setTimeout(150_000);
    const username = scopedUsername("senkron");
    const otherUsername = scopedUsername("senkronb");
    await createReadyUser(username);
    await createReadyUser(otherUsername);

    const contexts: BrowserContext[] = [];
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(desktop, mobile, other);

    try {
      const desktopPage = await desktop.newPage();
      const mobilePage = await mobile.newPage();
      const otherPage = await other.newPage();
      await loginAsUser(desktopPage, username);
      await loginAsUser(mobilePage, username);
      await loginAsUser(otherPage, otherUsername);

      // Mobil panel açık ve senkronizasyon çalışıyor; B kendi işlem listesinde bekliyor.
      await gotoReady(mobilePage, "/panel");
      await expect(mobilePage.getByTestId("sync-status")).toBeVisible();
      await gotoReady(otherPage, "/panel");
      const otherVersionBefore = await browserApi<{ revision: number }>(otherPage, "GET", "/api/portfolio/version");

      // 1) Masaüstünde BUY → mobil panel + işlem listesi sayfa yenilenmeden güncellenir.
      await gotoReady(desktopPage, "/islemler");
      await addPurchase(desktopPage, { quantity: "3", unitPrice: "5000" });
      await expect(mobilePage.getByTestId("stat-cost")).toContainText("15.000,00", { timeout: SYNC_TIMEOUT });
      await expect(mobilePage.getByTestId("holdings-list")).toContainText("Gram Altın", { timeout: SYNC_TIMEOUT });
      await expectNoHorizontalOverflow(mobilePage);

      // Masaüstü panelde bekler; mobil işlem listesi de eşitlenir.
      await gotoReady(desktopPage, "/panel");
      await expect(desktopPage.getByTestId("stat-cost")).toContainText("15.000,00");
      await gotoReady(mobilePage, "/islemler");
      await expect(mobilePage.getByTestId("transaction-list")).toContainText("Alış", { timeout: SYNC_TIMEOUT });

      // 2) Mobilde VOID → masaüstü panel sayfa yenilenmeden güncellenir.
      await mobilePage.getByRole("button", { name: "İptal et" }).first().click();
      await mobilePage.getByTestId("confirm-void").click();
      await expect(mobilePage.getByTestId("transaction-list")).toContainText("İptal edildi");
      await expect(desktopPage.getByTestId("stat-cost")).toContainText("0,00", { timeout: SYNC_TIMEOUT });
      await expect(desktopPage.getByTestId("portfolio-closed")).toBeVisible({ timeout: SYNC_TIMEOUT });

      // 3) User B hiçbir değişikliği görmez: defteri boş, sürümü değişmedi.
      const otherLedger = await browserApi<unknown[]>(otherPage, "GET", "/api/transactions");
      expect(otherLedger.data).toEqual([]);
      const otherVersionAfter = await browserApi<{ revision: number }>(otherPage, "GET", "/api/portfolio/version");
      expect(otherVersionAfter.data?.revision).toBe(otherVersionBefore.data?.revision ?? 0);
      await expect(otherPage.getByText("Henüz altın eklenmedi")).toBeVisible();

      // Sürüm ucu: kendi sürümü, ETag ile 304.
      const version = await browserApi<{ revision: number; updatedAt: string }>(desktopPage, "GET", "/api/portfolio/version");
      expect(version.status).toBe(200);
      expect(version.data?.revision).toBeGreaterThanOrEqual(2);
      const notModified = await desktopPage.evaluate(async (revision) => {
        const response = await fetch("/api/portfolio/version", { headers: { "If-None-Match": `W/"rev-${revision}"` }, cache: "no-store" });
        return { status: response.status, cache: response.headers.get("cache-control") };
      }, version.data?.revision ?? 0);
      expect(notModified.status).toBe(304);
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
