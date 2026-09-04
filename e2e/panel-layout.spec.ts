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
 * Kırılım eşiği 1280 px'tir:
 *   < 1280  tek sütun — canlı panel dashboard'un ALTINDA
 *   ≥ 1280  iki sütun — solda portföy, sağda dar canlı panel
 *
 * 1024'te iki sütun DENENDİ ve bırakıldı: ana sütun ~490 px'e düşüyor,
 * özet kartları sıkışıyordu. Kontrollü alt yerleşim daha okunaklı.
 */

test.describe("panel düzeni", () => {
  test("dashboard iki sütunlu ızgara kabında durur ve taşma yapmaz", async ({ page, viewport }) => {
    const username = scopedUsername("duzen");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/panel");

    const grid = page.getByTestId("dashboard-grid");
    await expect(grid).toBeVisible();

    const columns = await grid.evaluate((node) => window.getComputedStyle(node).gridTemplateColumns);
    const trackCount = columns.trim().split(/\s+/u).length;
    const width = viewport?.width ?? 0;

    if (width >= 1280) {
      expect(trackCount, `1280+ genişlikte iki sütun beklenir (${columns})`).toBe(2);
      // Sağ sütun ekranın yaklaşık beşte biri kadardır.
      const tracks = columns.trim().split(/\s+/u).map((value) => Number.parseFloat(value));
      const panelWidth = tracks[1]!;
      expect(panelWidth).toBeGreaterThanOrEqual(260);
      expect(panelWidth).toBeLessThanOrEqual(360);
    } else {
      expect(trackCount, `1280 altında tek sütun beklenir (${columns})`).toBe(1);
    }

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
