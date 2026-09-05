import { expect, test } from "@playwright/test";

import {
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  loginAsUser,
  scopedUsername,
} from "./helpers";

/**
 * PORTFÖY EKRANI DÜZENİ — ÜÇ KIRILIM
 *
 * Playwright projeleri üç genişlikte koşar (390, 1024, 1440), bu yüzden
 * testler viewport'u kendileri değiştirmez; o anki genişliğe göre BEKLENEN
 * davranışı doğrular.
 *
 * Panel artık HER genişlikte TEK sütundur. Yanındaki canlı fiyat paneli
 * panelden kaldırıldı; ham fiyat ekranı ayrı sayfada (/kayseri-fiyatlari)
 * duruyor. Eskiden 1280 px'te ikinci bir sütun açılırdı, o kırılım yok:
 * bu yüzden tek sütunluluk üç genişlikte de aynı şekilde doğrulanır.
 */

test.describe("panel düzeni", () => {
  test("dashboard tek sütunlu kapta durur ve taşma yapmaz", async ({ page }) => {
    const username = scopedUsername("duzen");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/panel");

    const grid = page.getByTestId("dashboard-grid");
    await expect(grid).toBeVisible();

    // Yan sütundaki canlı fiyat paneli panelden kaldırıldı; geri gelirse bu düşer.
    await expect(page.getByTestId("kayseri-live-panel")).toHaveCount(0);

    // Kap TEK sütundur. Kap bir ızgara değilse hesaplanan değer "none" olur;
    // ızgaraya çevrilirse iz sayısı okunur ve yine bire eşit olmalıdır.
    const columns = await grid.evaluate((node) => window.getComputedStyle(node).gridTemplateColumns);
    const trackCount = columns.trim() === "none" ? 1 : columns.trim().split(/\s+/u).length;
    expect(trackCount, `her genişlikte tek sütun beklenir (${columns})`).toBe(1);

    // Kap içerik alanının TAMAMINI kaplar: sağda ikinci bir sütuna yer ayrılmaz.
    const widths = await grid.evaluate((node) => ({
      container: node.getBoundingClientRect().width,
      main: node.closest("main")?.getBoundingClientRect().width ?? 0,
    }));
    expect(widths.main, "dashboard kabı <main> içinde olmalı").toBeGreaterThan(0);
    expect(
      Math.abs(widths.container - widths.main),
      `kap içerik alanını doldurmalı (kap=${widths.container}, ana=${widths.main})`,
    ).toBeLessThanOrEqual(1);

    await expectNoHorizontalOverflow(page);
  });

  test("mod düğmesi görünür ve mobil sekme çubuğunu örtmez", async ({ page, viewport }) => {
    const username = scopedUsername("moddugme");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/panel");

    const toggle = page.getByTestId("view-mode-toggle");
    await expect(toggle).toBeVisible();

    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();

    const height = viewport?.height ?? 0;
    const width = viewport?.width ?? 0;
    // Düğme ekranın içindedir.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);

    if (width < 1024) {
      // Mobilde alt gezinme çubuğu vardır; düğme onun ÜSTÜNDE durmalıdır.
      const navTop = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Ana gezinme"].fixed');
        return nav ? nav.getBoundingClientRect().top : null;
      });
      if (navTop !== null) {
        expect(box!.y + box!.height, "mod düğmesi alt sekme çubuğunu örtmemeli").toBeLessThanOrEqual(
          navTop + 1,
        );
      }
    }
  });

  test("işlemler ve fiyat kaynağı ekranlarında da taşma yoktur", async ({ page }) => {
    const username = scopedUsername("taşmayok");
    await createReadyUser(username);
    await loginAsUser(page, username);

    for (const path of ["/islemler", "/fiyat-kaynagi", "/ayarlar"]) {
      await gotoReady(page, path);
      await expectNoHorizontalOverflow(page);
    }
  });
});
