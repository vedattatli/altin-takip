import { expect, test } from "@playwright/test";

import {
  addPurchase,
  addSale,
  browserApi,
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

    for (const id of ["stat-liquidation", "stat-repurchase", "stat-cost", "stat-unrealized", "stat-realized", "stat-total-pnl"]) {
      await expect(page.getByTestId(id)).toHaveText(/0,00/);
    }
    await expect(page.getByText("Henüz altın eklenmedi")).toBeVisible();
    await expect(page.getByRole("link", { name: "Mevcut Altını Ekle" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Yeni Alış Ekle" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Satış Ekle" }).first()).toBeVisible();
    await expect(page.getByTestId("holdings-list")).toHaveCount(0);
  });

  test("fiyat kaynağı test verisi olarak etiketlenir", async ({ page }) => {
    await createReadyUser(scopedUsername("fiyatkaynak"));
    await loginAsUser(page, scopedUsername("fiyatkaynak"));

    const strip = page.getByTestId("price-source");
    await expect(strip).toContainText("Fiyat kaynağı:");
    await expect(strip.getByText("Test Verisi", { exact: true })).toBeVisible();
    await expect(strip.getByText("Gerçek piyasa verisi değil")).toBeVisible();
    await expect(strip.getByText("Test Piyasası", { exact: true })).toBeVisible();
    await expect(strip).toContainText("Son fiyat:");

    await strip.getByText("Bu fiyatlar hakkında").click();
    await expect(strip.getByText(/Gerçek piyasa fiyatı değildir/)).toBeVisible();
  });

  test("alış eklenince toplamlar doğru hesaplanır ve yenilemede korunur", async ({ page }) => {
    const username = scopedUsername("ekleme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await page.getByRole("link", { name: "İşlemler" }).first().click();
    await page.waitForURL("**/islemler");

    await addPurchase(page, { product: "Gram Altın", quantity: "10", unitPrice: "5000" });
    await expect(page.getByTestId("transaction-list").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("Alış eklendi.")).toBeVisible();

    await page.getByRole("link", { name: "Panel" }).first().click();
    await page.waitForURL("**/panel");

    // Elde kalan maliyet birebir doğrulanır: 10 x 5.000 = 50.000 TL
    await expect(page.getByTestId("stat-cost")).toHaveText(/50\.000,00/);

    const liquidation = parseMoney(await page.getByTestId("stat-liquidation").textContent());
    const repurchase = parseMoney(await page.getByTestId("stat-repurchase").textContent());
    expect(liquidation).toBeGreaterThan(0);
    expect(liquidation).toBeLessThan(repurchase);

    await expect(page.getByTestId("holdings-list")).toContainText("Gram Altın");
    await expect(page.getByTestId("cost-quality").first()).toHaveText("Gerçek maliyet");
    await expect(page.getByText("Maliyet bazlı K/Z").first()).toBeVisible();
    await expect(page.getByTestId("pnl-label-notice")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("stat-cost")).toHaveText(/50\.000,00/);
    await expect(page.getByTestId("holdings-list")).toContainText("Gram Altın");
  });

  test("ÖRNEK 1 — ağırlıklı ortalama: 5×3.500 + 5×4.200 + 5×3.700", async ({ page }) => {
    const username = scopedUsername("ornekbir");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await addPurchase(page, { product: "Gram Altın", quantity: "5", unitPrice: "3500" });
    await addPurchase(page, { product: "Gram Altın", quantity: "5", unitPrice: "4200" });
    await addPurchase(page, { product: "Gram Altın", quantity: "5", unitPrice: "3700" });

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/57\.000,00/);
    await expect(page.getByTestId("holdings-list")).toContainText("15 gram");
    await expect(page.getByTestId("holdings-list")).toContainText("3.800,00");
  });

  test("ÖRNEK 4 — satış ortalamayı değiştirmez, gerçekleşmiş K/Z ayrı gösterilir", async ({ page }) => {
    const username = scopedUsername("orneksatis");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await addPurchase(page, { product: "Gram Altın", quantity: "15", unitPrice: "3800" });
    await addSale(page, { product: "Gram Altın", quantity: "4", unitPrice: "4200" });
    await expect(page.getByText("Satış eklendi.")).toBeVisible();
    await expect(page.getByTestId("transaction-list")).toContainText("Satış");

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/41\.800,00/);
    await expect(page.getByTestId("stat-realized")).toHaveText(/\+₺?1\.600,00|1\.600,00/);
    await expect(page.getByTestId("holdings-list")).toContainText("11 gram");
    await expect(page.getByTestId("holdings-list")).toContainText("3.800,00");
  });

  test("ÖRNEK 5 — işçilik ve komisyon maliyete eklenir", async ({ page }) => {
    const username = scopedUsername("masraf");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await addPurchase(page, { product: "Gram Altın", quantity: "10", unitPrice: "5000", workmanship: "500", fees: "100" });
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/50\.600,00/);
    await expect(page.getByTestId("holdings-list")).toContainText("5.060,00");
  });

  test("mevcut altın: bugünden itibaren takip (MARKET_BASELINE) K/Z sıfırdan başlar", async ({ page }) => {
    const username = scopedUsername("mevcutbaseline");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await page.getByTestId("add-opening").click();
    await page.getByLabel("Altın türü").selectOption({ label: "Gram Altın" });
    await page.getByLabel(/^Miktar/).fill("100");
    await page.getByTestId("opening-next").click();

    await expect(page.getByTestId("cost-method-MARKET_BASELINE")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("opening-next").click();

    const confirm = page.getByTestId("baseline-confirm");
    await expect(confirm).toContainText("Bozdurma fiyatı");
    await expect(confirm).toContainText("Yeniden alım fiyatı");
    await expect(confirm).toContainText("mock · Test Piyasası");
    await expect(confirm).toContainText("Fiyat zamanı");
    await expect(confirm).toContainText("gerçek tarihsel alış maliyetiniz değildir");
    const initialValue = parseMoney(await page.getByTestId("baseline-initial-value").textContent());
    expect(initialValue).toBeGreaterThan(0);

    await page.getByTestId("submit-opening").click();
    await expect(page.getByText("Mevcut altın eklendi.")).toBeVisible();
    await expect(page.getByTestId("transaction-list")).toContainText("Takip başlangıç değeri");
    await expect(page.getByTestId("transaction-list")).toContainText("gerçek tarihsel maliyet değildir");

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("pnl-label-notice")).toContainText("Takip başlangıcından itibaren K/Z");
    await expect(page.getByTestId("cost-quality").first()).toHaveText("Takip başlangıç değeri");
    // Aynı fiyat dilimi içinde gerçekleşmemiş K/Z tam sıfırdır (30 sn'lik test fiyatı dilimi).
    const unrealized = parseMoney(await page.getByTestId("stat-unrealized").textContent());
    expect(Math.abs(unrealized)).toBeLessThan(initialValue * 0.05);
  });

  test("mevcut altın: gerçek maliyet (toplam) girişi", async ({ page }) => {
    const username = scopedUsername("mevcutgercek");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await page.getByTestId("add-opening").click();
    await page.getByLabel("Altın türü").selectOption({ label: "Çeyrek Altın" });
    await page.getByLabel(/^Miktar/).fill("14");
    await page.getByTestId("opening-next").click();
    await page.getByTestId("cost-method-ACTUAL").click();
    await page.getByRole("radio", { name: "Toplam maliyet", exact: true }).click();
    await page.getByLabel(/oplam maliyet \(TL\)/).fill("154600");
    await page.getByTestId("opening-next").click();
    await expect(page.getByText("11.042,86")).toBeVisible();
    await page.getByTestId("submit-opening").click();

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/154\.600,00/);
    await expect(page.getByTestId("cost-quality").first()).toHaveText("Gerçek maliyet");
  });

  test("mevcut altın: tahmini maliyet etiketi kalır", async ({ page }) => {
    const username = scopedUsername("mevcuttahmin");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    await page.getByTestId("add-opening").click();
    await page.getByLabel(/^Miktar/).fill("3");
    await page.getByTestId("opening-next").click();
    await page.getByTestId("cost-method-ESTIMATED").click();
    await page.getByLabel(/Tahmini ortalama birim maliyet/).fill("4000");
    await page.getByTestId("opening-next").click();
    await page.getByTestId("submit-opening").click();

    await expect(page.getByTestId("transaction-list")).toContainText("Tahmini maliyet");
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("cost-quality").first()).toHaveText("Tahmini maliyet");
    await expect(page.getByTestId("pnl-label-notice")).toBeVisible();
  });

  test("iptal hard delete değildir; kayıt 'İptal edildi' olarak kalır ve toplamlar sıfırlanır", async ({ page }) => {
    const username = scopedUsername("silme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "4", unitPrice: "5000" });

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/20\.000,00/);

    await gotoReady(page, "/islemler");
    await page.getByRole("button", { name: "İptal et" }).first().click();
    await expect(page.getByText("İşlem iptal edilsin mi?")).toBeVisible();
    await page.getByLabel("Sebep").fill("Yanlış girdim");
    await page.getByTestId("confirm-void").click();

    await expect(page.getByText(/İşlem iptal edildi/)).toBeVisible();
    await expect(page.getByTestId("transaction-list").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("transaction-list")).toContainText("İptal edildi");
    await expect(page.getByTestId("transaction-list")).toContainText("Yanlış girdim");

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/0,00/);
    // Geçmiş işlem var, açık pozisyon yok: CLOSED durumu ("Henüz altın eklenmedi" DENMEZ).
    await expect(page.getByTestId("portfolio-closed")).toBeVisible();
    await expect(page.getByText("Henüz altın eklenmedi")).toHaveCount(0);
  });

  test("düzeltme eski kaydı 'Düzeltildi' olarak bırakır, yeni kayıt ekler", async ({ page }) => {
    const username = scopedUsername("duzenleme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "2", unitPrice: "5000" });

    await page.getByRole("button", { name: "Düzelt" }).first().click();
    await page.getByLabel(/^Miktar/).fill("6");
    await page.getByRole("button", { name: "Düzeltmeyi kaydet" }).click();

    await expect(page.getByText(/İşlem düzeltildi/)).toBeVisible();
    await expect(page.getByTestId("transaction-list").getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("transaction-list")).toContainText("Düzeltildi");

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("stat-cost")).toHaveText(/30\.000,00/);
  });

  test("geçersiz miktar kabul edilmez", async ({ page }) => {
    const username = scopedUsername("gecersiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await page.getByTestId("add-buy").click();
    await page.getByLabel(/^Miktar/).fill("-5");
    await page.getByLabel(/^Birim alış fiyatı/).fill("5000");
    await page.getByTestId("submit-buy").click();

    await expect(page.getByText(/negatif olamaz|sıfırdan büyük/)).toBeVisible();
    await expect(page.getByTestId("transaction-list")).toHaveCount(0);
  });

  test("satış miktarı eldeki miktarı aşamaz", async ({ page }) => {
    const username = scopedUsername("satissiniri");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Gram Altın", quantity: "3", unitPrice: "5000" });
    await addSale(page, { product: "Gram Altın", quantity: "10", unitPrice: "5500" });

    await expect(page.getByText(/Satış miktarı elinizdeki miktarı aşamaz/)).toBeVisible();
  });

  test("adet ile takip edilen üründe ondalık miktar reddedilir", async ({ page }) => {
    const username = scopedUsername("adetkontrol");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await page.getByTestId("add-buy").click();
    await page.getByLabel("Altın türü").selectOption({ label: "Çeyrek Altın" });
    await page.getByLabel(/^Miktar/).fill("1,5");
    await page.getByLabel(/^Birim alış fiyatı/).fill("9000");
    await page.getByTestId("submit-buy").click();

    await expect(page.getByText(/tam sayı/)).toBeVisible();
  });

  test("aynı istek kimliğiyle yeniden gönderilen alış tek kayıt oluşturur", async ({ page }) => {
    const username = scopedUsername("idempotent");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const body = {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "2",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
      clientRequestId: `req-e2e-${username.replace(/[^a-z0-9]/gi, "")}`,
    };
    const first = await browserApi<{ replayed: boolean; entry: { id: string } }>(page, "POST", "/api/transactions", body);
    const second = await browserApi<{ replayed: boolean; entry: { id: string } }>(page, "POST", "/api/transactions", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.data?.replayed).toBe(true);
    expect(second.data?.entry.id).toBe(first.data?.entry.id);

    const conflict = await browserApi(page, "POST", "/api/transactions", { ...body, quantity: "3" });
    expect(conflict.status).toBe(409);

    const ledger = await browserApi<unknown[]>(page, "GET", "/api/transactions");
    expect(ledger.data).toHaveLength(1);
  });

  test("API sayıları ondalık dize olarak taşır; kayan nokta artığı görünmez", async ({ page }) => {
    const username = scopedUsername("decimalapi");
    await createReadyUser(username);
    await loginAsUser(page, username);

    for (const quantity of ["0.1", "0.2"]) {
      const created = await browserApi(page, "POST", "/api/transactions", {
        kind: "BUY",
        productId: "gram-altin",
        quantity,
        occurredAt: "2026-01-10",
        pricingInputMode: "UNIT_PRICE",
        unitPrice: "5000.33",
      });
      expect(created.status).toBe(201);
    }
    const summary = await browserApi<{ holdings: { position: { quantity: string } }[] }>(
      page,
      "GET",
      "/api/portfolio/summary",
    );
    expect(summary.data?.holdings[0]?.position.quantity).toBe("0.3");
    expect(JSON.stringify(summary.data)).not.toMatch(/0000000000/);
    await gotoReady(page, "/panel");
    await expect(page.getByTestId("holdings-list")).not.toContainText("0,30000000000000004");
  });

  test("aynı gün saatli işlemler gerçek sırayla oynatılır; takvimde olmayan tarih 400 döner", async ({ page }) => {
    const username = scopedUsername("saatsira");
    await createReadyUser(username);
    await loginAsUser(page, username);
    const base = { productId: "kulce-24-ayar", pricingInputMode: "UNIT_PRICE" };

    const badDate = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY", ...base, quantity: "1", occurredAt: "2026-02-30", unitPrice: "5000",
    });
    expect(badDate.status).toBe(400);
    const leap = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY", ...base, quantity: "1", occurredAt: "2024-02-29", unitPrice: "5000",
    });
    expect(leap.status).toBe(201);

    const buy = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY", ...base, quantity: "2", occurredAt: "2026-02-10", occurredTime: "10:00", unitPrice: "5000",
    });
    expect(buy.status).toBe(201);
    const sell = await browserApi<{ entry: { occurredTime: string | null; occurredAtInstant: string } }>(
      page,
      "POST",
      "/api/transactions",
      { kind: "SELL", ...base, quantity: "3", occurredAt: "2026-02-10", occurredTime: "11:00", unitPrice: "5100" },
    );
    expect(sell.status).toBe(201);
    expect(sell.data?.entry.occurredTime).toBe("11:00");
    expect(sell.data?.entry.occurredAtInstant).toBe("2026-02-10T08:00:00.000Z");

    // Aynı gün, alıştan ÖNCEKİ saate satış: kronolojik olarak eldeki 1 gramı aşar.
    const early = await browserApi(page, "POST", "/api/transactions", {
      kind: "SELL", ...base, quantity: "2", occurredAt: "2026-02-10", occurredTime: "09:00", unitPrice: "5100",
    });
    expect(early.status).toBe(400);

    await gotoReady(page, "/islemler");
    await expect(page.getByTestId("transaction-list")).toContainText("11:00");
    await expect(page.getByTestId("transaction-list")).toContainText("10:00");
  });

  test("sayı girişi: iç boşluk ve belirsiz ayırıcı reddedilir; girilen fiyat ile efektif maliyet ayrı gösterilir", async ({ page }) => {
    const username = scopedUsername("sayigirdi");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");
    await page.getByTestId("add-buy").click();
    await page.getByLabel(/^Miktar/).fill("1 2");
    await page.getByLabel(/^Birim alış fiyatı/).fill("5.000");
    await page.getByTestId("submit-buy").click();
    await expect(page.getByText(/boşluk/)).toBeVisible();
    await expect(page.getByText(/belirsiz/)).toBeVisible();

    await page.getByLabel(/^Miktar/).fill("10");
    await page.getByLabel("İşlem tarihi").fill("2026-02-10");
    await page.getByTestId("occurred-time").fill("14:30");
    await page.getByLabel(/^Birim alış fiyatı/).fill("5000");
    await page.getByLabel(/^İşçilik/).fill("500");
    await page.getByLabel(/^Komisyon/).fill("100");
    await expect(page.getByTestId("buy-preview-prices")).toContainText("5.000,00");
    await expect(page.getByTestId("buy-preview-prices")).toContainText("5.060,00");
    await page.getByTestId("submit-buy").click();
    await expect(page.getByTestId("transaction-list")).toBeVisible();
    await expect(page.getByTestId("transaction-list")).toContainText("Birim fiyat ₺5.000,00");
    await expect(page.getByTestId("transaction-list")).toContainText("Efektif ₺5.060,00");
    await expect(page.getByTestId("transaction-list")).toContainText("14:30");
    await expectNoHorizontalOverflow(page);

    const summary = await browserApi<{ holdings: { position: { averageCost: string; holdingCostOrigins: { actual: boolean } } }[] }>(
      page,
      "GET",
      "/api/portfolio/summary",
    );
    expect(summary.data?.holdings[0]?.position.averageCost).toBe("5060");
    expect(summary.data?.holdings[0]?.position.holdingCostOrigins.actual).toBe(true);
  });

  test("GET uçları veri değiştirmez", async ({ page }) => {
    const username = scopedUsername("getyanetkisiz");
    await createReadyUser(username);
    await loginAsUser(page, username);
    for (let index = 0; index < 3; index += 1) {
      await browserApi(page, "GET", "/api/portfolio");
      await browserApi(page, "GET", "/api/portfolio/summary");
      await browserApi(page, "GET", "/api/transactions");
    }
    const ledger = await browserApi<unknown[]>(page, "GET", "/api/transactions");
    expect(ledger.data).toHaveLength(0);
  });

  test("tüm ekranlarda yatay taşma yoktur", async ({ page }) => {
    const username = scopedUsername("tasma");
    await createReadyUser(username);
    await loginAsUser(page, username);

    await gotoReady(page, "/islemler");
    await addPurchase(page, { product: "Tam Altın", quantity: "3", unitPrice: "38500" });

    for (const path of ["/panel", "/islemler", "/islemler?ekle=mevcut", "/islemler?ekle=satis", "/ayarlar"]) {
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
