import { expect, test } from "@playwright/test";

import {
  addPurchase,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  loginAsUser,
  scopedUsername,
} from "./helpers";

/** Sayısal metinden TL tutarını çıkarır (₺53.410,25 -> 53410.25). */
function parseMoney(text: string | null): number {
  if (!text) return Number.NaN;
  const cleaned = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  return Number(cleaned);
}

test.describe("portföy akışı", () => {
  test("yeni hesap tamamen boş açılır", async ({ page }) => {
    await createReadyUser(scopedUsername("bospanel"));
    await loginAsUser(page, scopedUsername("bospanel"));

    await expect(page.getByTestId("stat-liquidation")).toHaveText(/0,00/);
    await expect(page.getByTestId("stat-repurchase")).toHaveText(/0,00/);
    await expect(page.getByTestId("stat-cost")).toHaveText(/0,00/);
    await expect(page.getByTestId("stat-pnl")).toHaveText(/0,00/);

    await expect(page.getByText("Henüz altın eklenmedi")).toBeVisible();
    await expect(page.getByRole("link", { name: "Altın Ekle" }).first()).toBeVisible();
    await expect(page.getByTestId("holdings-list")).toHaveCount(0);
  });

  test("fiyat kaynağı test verisi olarak etiketlenir", async ({ page }) => {
    await createReadyUser(scopedUsername("fiyatkaynak"));
    await loginAsUser(page, scopedUsername("fiyatkaynak"));

    // Tek satırlık şerit panelin altındadır; bilgiler yine de her zaman görünür.
    const strip = page.getByTestId("price-source");
    await expect(strip).toContainText("Fiyat kaynağı:");
    await expect(strip.getByText("Test Verisi", { exact: true })).toBeVisible();
    await expect(strip.getByText("Gerçek piyasa verisi değil")).toBeVisible();
    await expect(strip.getByText("TEST", { exact: true })).toBeVisible();
    await expect(strip).toContainText("Son fiyat:");

    // Uzun açıklama katlanmış durur ama erişilebilir kalır.
    await strip.getByText("Bu fiyatlar hakkında").click();
    await expect(strip.getByText(/Gerçek piyasa fiyatı değildir/)).toBeVisible();
  });

  test("altın eklenince toplamlar doğru hesaplanır ve yenilemede korunur", async ({ page }) => {
    const username = scopedUsername("ekleme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await page.getByRole("link", { name: "İşlemler" }).first().click();
    await page.waitForURL("**/islemler");

    await addPurchase(page, { product: "Gram Altın", quantity: "10", unitPrice: "5000" });
    await expect(page.getByTestId("transaction-list").getByRole("listitem")).toHaveCount(1);

    await page.getByRole("link", { name: "Panel" }).first().click();
    await page.waitForURL("**/panel");

    // Toplam maliyet birebir doğrulanır: 10 x 5.000 = 50.000 TL
    await expect(page.getByTestId("stat-cost")).toHaveText(/50\.000,00/);

    const liquidation = parseMoney(await page.getByTestId("stat-liquidation").textContent());
    const repurchase = parseMoney(await page.getByTestId("stat-repurchase").textContent());

    expect(liquidation).toBeGreaterThan(0);
    // Bozdurma değeri (piyasa ALIŞ) her zaman yeniden alım değerinden (piyasa SATIŞ) düşüktür.
    expect(liquidation).toBeLessThan(repurchase);

    await expect(page.getByTestId("holdings-list")).toContainText("Gram Altın");
    await expect(page.getByText("Henüz altın eklenmedi")).toHaveCount(0);

    // Sayfa yenilendiğinde veriler korunur.
    await page.reload();
    await expect(page.getByTestId("stat-cost")).toHaveText(/50\.000,00/);
    await expect(page.getByTestId("holdings-list")).toContainText("Gram Altın");
  });

  test("kayıt silinince toplamlar sıfırlanır", async ({ page }) => {
    const username = scopedUsername("silme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "4", unitPrice: "5000" });

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/20\.000,00/);

    await gotoReady(page, "/islemler");
    await page.getByRole("button", { name: "Sil" }).first().click();
    await expect(page.getByText("İşlem silinsin mi?")).toBeVisible();
    await page.getByTestId("confirm-delete").click();

    await expect(page.getByText("İşlem silindi.")).toBeVisible();
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/0,00/);
    await expect(page.getByText("Henüz altın eklenmedi")).toBeVisible();
  });

  test("geçersiz miktar kabul edilmez", async ({ page }) => {
    const username = scopedUsername("gecersiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await page.getByTestId("add-transaction").click();
    await page.getByLabel(/^Miktar/).fill("-5");
    await page.getByLabel(/^Birim alış fiyatı/).fill("5000");
    await page.getByRole("button", { name: "İşlemi kaydet" }).click();

    await expect(page.getByText("Miktar sıfırdan büyük olmalıdır.")).toBeVisible();
    await expect(page.getByTestId("transaction-list")).toHaveCount(0);
  });

  test("satış miktarı eldeki miktarı aşamaz", async ({ page }) => {
    const username = scopedUsername("satissiniri");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "3", unitPrice: "5000" });

    await page.getByTestId("add-transaction").click();
    await page.getByRole("radio", { name: "Satış" }).click();
    await page.getByLabel(/^Miktar/).fill("10");
    await page.getByLabel(/^Birim satış fiyatı/).fill("5500");
    await page.getByRole("button", { name: "İşlemi kaydet" }).click();

    await expect(page.getByText(/Satış miktarı elinizdeki miktarı aşamaz/)).toBeVisible();
  });

  test("adet ile takip edilen üründe ondalık miktar reddedilir", async ({ page }) => {
    const username = scopedUsername("adetkontrol");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await page.getByTestId("add-transaction").click();
    await page.getByLabel("Altın türü").selectOption({ label: "Yeni Çeyrek" });
    await page.getByLabel(/^Miktar/).fill("1,5");
    await page.getByLabel(/^Birim alış fiyatı/).fill("9000");
    await page.getByRole("button", { name: "İşlemi kaydet" }).click();

    await expect(page.getByText(/tam sayı olmalıdır/)).toBeVisible();
  });

  test("işlem düzenlenebilir", async ({ page }) => {
    const username = scopedUsername("duzenleme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "2", unitPrice: "5000" });

    await page.getByRole("button", { name: "Düzenle" }).first().click();
    await page.getByLabel(/^Miktar/).fill("6");
    await page.getByRole("button", { name: "Değişiklikleri kaydet" }).click();

    await expect(page.getByText("İşlem güncellendi.")).toBeVisible();
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/30\.000,00/);
  });

  test("tüm ekranlarda yatay taşma yoktur", async ({ page }) => {
    const username = scopedUsername("tasma");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Cumhuriyet Altını", quantity: "3", unitPrice: "38500" });

    for (const path of ["/panel", "/islemler", "/ayarlar"]) {
      await gotoReady(page, path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test("kullanıcılar birbirinin portföyünü görmez", async ({ page }) => {
    const first = scopedUsername("izolasyon.bir");
    const second = scopedUsername("izolasyon.iki");
    await createReadyUser(first);
    await createReadyUser(second);

    await loginAsUser(page, first);
    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "7", unitPrice: "5000" });
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/35\.000,00/);

    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");

    await loginAsUser(page, second);
    await expect(page.getByTestId("stat-cost")).toHaveText(/0,00/);
    await expect(page.getByText("Henüz altın eklenmedi")).toBeVisible();
  });
});
