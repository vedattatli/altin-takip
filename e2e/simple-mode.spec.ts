import { expect, test } from "@playwright/test";

import {
  browserApi,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  login,
  scopedUsername,
} from "./helpers";

/**
 * BASİT / DETAYLI GÖRÜNÜM MODU
 *
 * Bu dosya BİLEREK `loginAsUser` kullanmaz: o yardımcı modu detaylıya çeker.
 * Buradaki testlerin amacı uygulamanın VARSAYILAN hâlini doğrulamaktır.
 *
 * Kritik güvence: mod yalnızca ARAYÜZÜ değiştirir. Aynı kullanıcı, aynı
 * kayıtlar, aynı hesaplar — sadece daha az şey gösterilir.
 */

async function signIn(page: import("@playwright/test").Page, username: string) {
  await createReadyUser(username);
  await login(page, username);
  await page.waitForURL("**/panel");
}

test.describe("görünüm modu", () => {
  test("varsayılan basit moddur: satış yok, tek kâr/zarar kartı", async ({ page }) => {
    const username = scopedUsername("basitmod");
    await signIn(page, username);

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "basit");

    // Basit modda gösterilenler.
    await expect(page.getByTestId("stat-liquidation")).toBeVisible();
    await expect(page.getByTestId("stat-cost")).toBeVisible();
    await expect(page.getByTestId("stat-simple-pnl")).toBeVisible();

    // Basit modda gizlenenler.
    await expect(page.getByTestId("stat-repurchase")).toHaveCount(0);
    await expect(page.getByTestId("stat-unrealized")).toHaveCount(0);
    await expect(page.getByTestId("stat-realized")).toHaveCount(0);
    await expect(page.getByTestId("stat-total-pnl")).toHaveCount(0);

    // "Gerçekleşmemiş" kelimesi basit modda geçmez; sadece "Kâr/Zarar" yazar.
    await expect(page.locator("body")).not.toContainText("Gerçekleşmemiş kâr/zarar");
    await expect(page.locator("body")).toContainText("Kâr/Zarar");

    await expectNoHorizontalOverflow(page);
  });

  test("basit modda satış ekleme düğmesi yoktur; detaylı modda geri gelir", async ({ page }) => {
    const username = scopedUsername("basitsatis");
    await signIn(page, username);

    await gotoReady(page, "/islemler");
    await expect(page.getByTestId("add-buy")).toBeVisible();
    await expect(page.getByTestId("add-opening")).toBeVisible();
    await expect(page.getByTestId("add-sell")).toHaveCount(0);
    // Basit modda birincil düğme gündelik diliyle yazılır; "alış" jargonu geçmez.
    await expect(page.getByTestId("add-buy")).toContainText("Yeni aldığım altını ekle");

    // Tek tıkla detaylı moda geçilir.
    await page.getByTestId("view-mode-toggle").click();
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "detayli");
    await expect(page.getByTestId("add-sell")).toBeVisible();
    await expect(page.getByTestId("add-buy")).toContainText("Yeni alış ekle");
  });

  test("mod tercihi sayfa değişince ve yenilenince korunur", async ({ page }) => {
    const username = scopedUsername("modkalici");
    await signIn(page, username);

    await gotoReady(page, "/panel");
    await page.getByTestId("view-mode-toggle").click();
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "detayli");

    await gotoReady(page, "/islemler");
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "detayli");

    await page.reload();
    await page.waitForSelector('html[data-hydrated="true"]');
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "detayli");
  });

  test("mod muhasebeyi DEĞİŞTİRMEZ: aynı kayıt, aynı toplamlar", async ({ page }) => {
    const username = scopedUsername("modmuhasebe");
    await signIn(page, username);

    const created = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "2",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });
    expect(created.status).toBe(201);

    const simple = await browserApi<{ totalRemainingCostBasis: string; totalRealizedPnl: string }>(
      page,
      "GET",
      "/api/portfolio/summary",
    );

    await gotoReady(page, "/panel");
    await page.getByTestId("view-mode-toggle").click();
    await expect(page.getByTestId("view-mode-toggle")).toHaveAttribute("data-mode", "detayli");

    const detailed = await browserApi<{ totalRemainingCostBasis: string; totalRealizedPnl: string }>(
      page,
      "GET",
      "/api/portfolio/summary",
    );

    expect(detailed.data?.totalRemainingCostBasis).toBe(simple.data?.totalRemainingCostBasis);
    expect(detailed.data?.totalRealizedPnl).toBe(simple.data?.totalRealizedPnl);
    expect(simple.data?.totalRemainingCostBasis).toBe("10000");

    // Kayıt her iki modda da defterde durur.
    const ledger = await browserApi<{ totalPaid: string }[]>(page, "GET", "/api/transactions");
    expect(ledger.data?.[0]?.totalPaid).toBe("10000");
  });

  /*
   * TEK LİSTE, ÜÇ BAŞLIK, KATALOG ADLARI, FİYATLI.
   *
   * "Sık kullanılan altı ürün" bölümü kaldırıldı: aynı ürün ailesi iki yerde
   * görünüyordu (üstte "Çeyrek Altın", altta "Yeni Çeyrek") ve hangisinin ne
   * olduğu belirsizdi. Artık her ürün katalog adıyla, ait olduğu başlık
   * altında, güncel bozdurma fiyatıyla birlikte tek listede.
   */
  test("varlık listesi Altınlar / Döviz / Gümüş başlıkları altında ve fiyatlı", async ({ page }) => {
    const username = scopedUsername("varlikliste");
    await signIn(page, username);

    await gotoReady(page, "/islemler");
    await page.getByTestId("add-buy").click();
    const select = page.getByLabel("Varlık türü");

    // Başlıklar ve SIRALARI.
    const groups = await select.locator("optgroup").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("label")),
    );
    expect(groups).toEqual(["Altınlar", "Döviz", "Gümüş"]);

    // Ziynetin yeni/eskisi AYRI satırlardır; birleştirilmez.
    const labels = await select.locator("option").allTextContents();
    const joined = labels.join("|");
    for (const expected of ["Yeni Çeyrek", "Eski Çeyrek", "24 Ayar Külçe", "22 Ayar Altın", "Gram Altın"]) {
      expect(joined, expected).toContain(expected);
    }

    // Döviz ve gümüş kendi başlıkları altında.
    const fx = await select.locator('optgroup[label="Döviz"] option').allTextContents();
    expect(fx.join("|")).toContain("Amerikan Doları");
    expect(fx.join("|")).toContain("Euro");
    const silver = await select.locator('optgroup[label="Gümüş"] option').allTextContents();
    expect(silver.join("|")).toContain("Gram Gümüş");

    // Her satır fiyat bilgisi taşır: ya güncel fiyat ya da "fiyat yok".
    for (const label of labels) {
      expect(label.includes(" ₺") || label.endsWith("fiyat yok"), label).toBe(true);
    }

    // Katalogda ne varsa listede de var; hiçbir ürün gizlenmiyor.
    expect(labels.length).toBe(25);
  });

  test("elde gizli üründen kayıt varsa listede ve 'Diğer varlıklar'da görünür", async ({ page }) => {
    const username = scopedUsername("digervarlik");
    await signIn(page, username);

    // Katalogda olan ama varsayılan listede olmayan bir ürün API ile eklenir.
    const created = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "cumhuriyet-altini",
      quantity: "1",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "40000",
    });
    expect(created.status).toBe(201);

    await gotoReady(page, "/panel");
    // Kayıt KAYBOLMAZ: "Diğer varlıklar" altında görünür.
    await expect(page.getByTestId("other-holdings-section")).toBeVisible();
    await expect(page.getByTestId("other-holdings-list")).toContainText("Cumhuriyet");

    // Ve satılabilmesi için seçim listesine eklenir.
    await gotoReady(page, "/islemler");
    await page.getByTestId("add-buy").click();
    const labels = await page.getByLabel("Varlık türü").locator("option").allTextContents();
    expect(labels.join("|")).toContain("Cumhuriyet");
  });
});
