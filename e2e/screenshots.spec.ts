import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

import { addPurchase, createReadyUser, gotoReady, loginAsUser, scopedUsername } from "./helpers";

/**
 * Belgeler için ekran görüntüsü üretir.
 * Yalnızca mobil ve masaüstü genişliklerinde çalışır.
 */
const TARGETS: Record<string, { path: string; fullPage: boolean }> = {
  // Mobilde alt gezinme çubuğu sabittir; tam sayfa yakalamada içeriğin ortasına
  // düşeceği için gerçek telefon görünümü (viewport) yakalanır.
  "mobil-390": { path: "docs/screenshots/mobile.png", fullPage: false },
  "masaustu-1440": { path: "docs/screenshots/desktop.png", fullPage: true },
};

test("panel ekran görüntüsü", async ({ page }, testInfo) => {
  const target = TARGETS[testInfo.project.name];
  test.skip(!target, "Bu ekran genişliği için görüntü üretilmiyor.");

  const username = scopedUsername("goruntu");
  await createReadyUser(username, "Ekran Görüntüsü");
  await loginAsUser(page, username);

  await gotoReady(page, "/islemler");
  // Varsayılan listedeki altı üründen dördü: ekran görüntüsü gerçek akışı
  // yansıtsın diye gizlenmiş ürün kullanılmaz.
  await addPurchase(page, { product: "gram-altin", quantity: "24,5", unitPrice: "5180" });
  await addPurchase(page, { product: "yeni-tam", quantity: "6", unitPrice: "38400" });
  await addPurchase(page, { product: "ata-altin", quantity: "4", unitPrice: "39750" });
  await addPurchase(page, { product: "yeni-ceyrek", quantity: "12", unitPrice: "8950" });

  await gotoReady(page, "/panel");
  await expect(page.getByTestId("holdings-list")).toBeVisible();
  // Göreli zaman metninin yerleşmesini bekle.
  await expect(page.getByText("Fiyat kaynağı:", { exact: true })).toBeVisible();

  mkdirSync("docs/screenshots", { recursive: true });
  await page.screenshot({ path: target.path, fullPage: target.fullPage });
});
