import { expect, test } from "@playwright/test";

import { browserApi, createReadyUser, expectNoHorizontalOverflow, gotoReady, loginAsUser, scopedUsername } from "./helpers";

/**
 * DEĞERLEME KAPSAMI VE PORTFÖY DURUMU
 *
 * Test sunucusu `PRICE_MOCK_UNAVAILABLE_PRODUCTS=resat-altin,hamit-altin` ile başlar:
 * test sağlayıcısı bu ürünler için fiyat üretmez (uydurma fiyat yoktur). Böylece
 * "hiç fiyat yok" (none) ve "kısmi" (partial) durumları gerçek arayüzde doğrulanır.
 */

async function buy(page: import("@playwright/test").Page, productId: string, quantity: string, unitPrice: string) {
  const created = await browserApi(page, "POST", "/api/transactions", {
    kind: "BUY",
    productId,
    quantity,
    occurredAt: "2026-01-10",
    pricingInputMode: "UNIT_PRICE",
    unitPrice,
  });
  expect(created.status).toBe(201);
}

test.describe("değerleme kapsamı", () => {
  test("D. açık pozisyon var, hiç kullanılabilir fiyat yok → 'Fiyat yok'; maliyet ve gerçekleşmiş K/Z görünür", async ({ page }) => {
    const username = scopedUsername("fiyatyok");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await buy(page, "resat-altin", "2", "40000");

    await gotoReady(page, "/panel");
    const root = page.locator("[data-portfolio-state]");
    await expect(root).toHaveAttribute("data-portfolio-state", "OPEN");
    await expect(root).toHaveAttribute("data-valuation-status", "none");
    // Panel muhasebe dilini değil günlük Türkçeyi basar: motorun
    // "Fiyat verisi kullanılamıyor" sabiti ekranda "Fiyat yok" olarak görünür.
    // Sıfır YAZILMAMASI kuralı aynen sınanmaya devam eder.
    await expect(page.getByTestId("stat-liquidation")).toContainText("Fiyat yok");
    await expect(page.getByTestId("stat-repurchase")).toContainText("Fiyat yok");
    await expect(page.getByTestId("stat-unrealized")).toContainText("Fiyat yok");
    await expect(page.getByTestId("stat-total-pnl")).toContainText("Fiyat yok");
    await expect(page.getByTestId("stat-liquidation")).not.toContainText("0,00");
    await expect(page.getByTestId("stat-cost")).toContainText("80.000,00");
    await expect(page.getByTestId("stat-realized")).toContainText("0,00");
    await expect(page.getByTestId("valuation-none")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("C. bazı fiyatlar kullanılabilir → kısmi değerleme etiketi; toplamlar yalnızca fiyatı bulunanları kapsar", async ({ page }) => {
    const username = scopedUsername("kismi");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await buy(page, "resat-altin", "1", "40000");
    await buy(page, "gram-altin", "2", "5000");

    await gotoReady(page, "/panel");
    await expect(page.locator("[data-valuation-status]")).toHaveAttribute("data-valuation-status", "partial");
    await expect(page.getByTestId("partial-valuation")).toBeVisible();
    await expect(page.getByText("Tahmini bozdurma değeri (kısmi)")).toBeVisible();
    await expect(page.getByText("Toplam kâr/zarar (kısmi)")).toBeVisible();
    await expect(page.getByTestId("partial-valuation")).toContainText("40.000,00");
    await expect(page.getByTestId("stat-liquidation")).not.toContainText("Fiyat yok");
    await expectNoHorizontalOverflow(page);
  });

  test("CLOSED: tamamı satılmış portföyde gerçekleşmiş K/Z ve düğmeler görünür; 'Henüz altın eklenmedi' denmez", async ({ page }) => {
    const username = scopedUsername("kapali");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await buy(page, "gram-altin", "2", "5000");
    const sold = await browserApi(page, "POST", "/api/transactions", {
      kind: "SELL",
      productId: "gram-altin",
      quantity: "2",
      occurredAt: "2026-01-20",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5500",
    });
    expect(sold.status).toBe(201);

    await gotoReady(page, "/panel");
    await expect(page.locator("[data-portfolio-state]")).toHaveAttribute("data-portfolio-state", "CLOSED");
    await expect(page.getByTestId("portfolio-closed")).toBeVisible();
    await expect(page.getByTestId("portfolio-closed")).toContainText(
      "Elinizde varlık kalmadı; geçmiş kayıtlarınız duruyor.",
    );
    // Liste yerinde de "açık pozisyon yok" denmeye devam eder; şeritteki daha
    // uzun cümleyle karışmasın diye TAM eşleşme aranır.
    await expect(page.getByText("Elinizde varlık kalmadı", { exact: true })).toBeVisible();
    await expect(page.getByText("Henüz altın eklenmedi")).toHaveCount(0);
    await expect(page.getByTestId("stat-realized")).toContainText("1.000,00");
    await expect(page.getByTestId("stat-total-pnl")).toContainText("1.000,00");
    await expect(page.getByRole("link", { name: "Mevcut Altını Ekle" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Yeni Alış Ekle" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("A. hiç işlem yoksa NEVER_USED ve 0 TL", async ({ page }) => {
    const username = scopedUsername("hicyok");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/panel");
    await expect(page.locator("[data-portfolio-state]")).toHaveAttribute("data-portfolio-state", "NEVER_USED");
    await expect(page.getByText("Henüz altın eklenmedi")).toBeVisible();
    await expect(page.getByTestId("stat-liquidation")).toContainText("0,00");
  });
});
