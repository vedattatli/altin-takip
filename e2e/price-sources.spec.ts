import { expect, test } from "@playwright/test";

import { ADMIN } from "./global-setup";
import { E2E_CRON_SECRET } from "./test-env";
import {
  browserApi,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  loginAsAdmin,
  loginAsUser,
  scopedUsername,
} from "./helpers";

/**
 * FİYAT KAYNAKLARI — uçtan uca.
 *
 * Test ortamında yalnızca test sağlayıcısı (mock) lisanslıdır; lisanssız
 * kaynaklar etkinleştirilemez ve kullanıcıya sunulmaz. Gerçek sağlayıcıya
 * bağlanılmaz.
 */

test.describe("fiyat kaynakları", () => {
  test("yönetici lisanssız kaynağı etkinleştiremez; test kaynağını açabilir", async ({ page }) => {
    await loginAsAdmin(page, ADMIN.username, ADMIN.password);
    await gotoReady(page, "/yonetim/fiyat-kaynaklari");

    await expect(page.getByTestId("admin-price-sources")).toBeVisible();
    await expect(page.getByText("Kayseri Yerel Piyasa", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Sarraf Pro \/ KAYSARDER/).first()).toBeVisible();
    // Harem'in resmî servisi iddiası hiçbir yerde geçmez.
    await expect(page.getByText(/Harem resmî/i)).toHaveCount(0);
    await expect(page.getByText(/AltinAPI — bağımsız veri sağlayıcısı/).first()).toBeVisible();

    // Lisanssız kaynak API üzerinden de etkinleştirilemez.
    const blocked = await browserApi(page, "PATCH", "/api/admin/price-sources/harem-direct", {
      enabled: true,
      userSelectable: true,
    });
    expect(blocked.status).toBe(409);

    const enabled = await browserApi(page, "PATCH", "/api/admin/price-sources/mock", {
      enabled: true,
      userSelectable: true,
    });
    expect(enabled.status).toBe(200);
    const refreshed = await browserApi<{ status: string; accepted: number }>(
      page,
      "POST",
      "/api/admin/price-sources/mock/refresh",
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.data?.accepted).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
  });

  test("kullanıcı yalnızca açık kaynağı seçer; değişim onay ister ve geçmişi değiştirmez", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage, ADMIN.username, ADMIN.password);
    await browserApi(adminPage, "PATCH", "/api/admin/price-sources/mock", { enabled: true, userSelectable: true });
    await browserApi(adminPage, "POST", "/api/admin/price-sources/mock/refresh");

    const username = scopedUsername("kaynaksecim");
    await createReadyUser(username);
    await loginAsUser(page, username);

    // Lisanssız kaynak kullanıcıya sunulmaz ve seçilemez.
    const sources = await browserApi<{ options: { providerCode: string }[] }>(page, "GET", "/api/price-sources");
    expect(sources.status).toBe(200);
    expect(sources.data?.options.map((option) => option.providerCode)).toEqual(["mock"]);
    const rejected = await browserApi(page, "POST", "/api/price-sources", { providerCode: "harem-direct" });
    expect(rejected.status).toBe(409);
    const reference = await browserApi(page, "POST", "/api/price-sources", { providerCode: "bist-reference" });
    expect(reference.status).toBe(409);

    // Portföyde işlem oluştur ve değerlemeyi kaydet.
    const created = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "2",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });
    expect(created.status).toBe(201);

    await gotoReady(page, "/fiyat-kaynagi");
    await expect(page.getByTestId("active-source")).toBeVisible();
    await expect(page.getByTestId("source-options")).toContainText("Test Verisi");

    // Kaynak değişimi açık onay ister.
    await page.getByTestId("select-mock").click();
    await expect(page.getByTestId("source-confirm")).toContainText("Geçmiş işlem maliyetleriniz");
    await page.getByTestId("confirm-source-change").click();
    await expect(page.getByTestId("source-events")).toBeVisible();

    // Defter ve gerçekleşmiş K/Z değişmez.
    const ledger = await browserApi<{ totalPaid: string }[]>(page, "GET", "/api/transactions");
    expect(ledger.data?.[0]?.totalPaid).toBe("10000");
    const summary = await browserApi<{ totalRemainingCostBasis: string; totalRealizedPnl: string }>(
      page,
      "GET",
      "/api/portfolio/summary",
    );
    expect(summary.data?.totalRemainingCostBasis).toBe("10000");
    expect(summary.data?.totalRealizedPnl).toBe("0");
    await expectNoHorizontalOverflow(page);

    // Karşılaştırma ekranı değerleme kaynağını değiştirmez.
    const before = await browserApi<{ activeProviderCode: string }>(page, "GET", "/api/price-sources/compare");
    expect(before.data?.activeProviderCode).toBe("mock");
    await expect(page.getByTestId("compare-table")).toBeVisible();
    const after = await browserApi<{ active: { providerCode: string } }>(page, "GET", "/api/price-sources");
    expect(after.data?.active.providerCode).toBe("mock");

    await adminContext.close();
  });

  test("panelde aktif kaynak, piyasa ve güncellik görünür; test verisi etiketli kalır", async ({ page, browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage, ADMIN.username, ADMIN.password);
    await browserApi(adminPage, "PATCH", "/api/admin/price-sources/mock", { enabled: true, userSelectable: true });
    await browserApi(adminPage, "POST", "/api/admin/price-sources/mock/refresh");
    await adminContext.close();

    const username = scopedUsername("kaynakpanel");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await browserApi(page, "POST", "/api/price-sources", { providerCode: "mock" });
    await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "1",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });

    await gotoReady(page, "/panel");
    await expect(page.getByTestId("active-price-source")).toContainText("Test Verisi");
    await expect(page.getByTestId("active-price-source")).toContainText("Gerçek piyasa verisi değil");
    await expect(page.getByTestId("active-price-source")).toContainText("Son güncelleme");
    await expectNoHorizontalOverflow(page);
  });

  test("zamanlanmış alım ucu secret olmadan çalışmaz", async ({ page }) => {
    const username = scopedUsername("cronucu");
    await createReadyUser(username);
    await loginAsUser(page, username);
    const denied = await browserApi(page, "POST", "/api/cron/price-ingestion");
    expect(denied.status).toBe(403);
  });

  test("sağlık ucu kimliksiz yalın durum döner; secret ayrıntıyı açar", async ({ page }) => {
    await gotoReady(page, "/giris");

    // Kimliksiz: yalnızca durum ve zaman. Sağlayıcı, sürüm veya ortam bilgisi YOK.
    const plain = await page.evaluate(async () => {
      const response = await fetch("/api/health");
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    });
    expect(plain.status).toBe(200);
    const plainData = plain.body.data as Record<string, unknown>;
    expect(plainData.status).toBe("ok");
    expect(Object.keys(plainData).sort()).toEqual(["checkedAt", "status"]);

    // Secret ile: sağlayıcı sağlık özeti eklenir; adres/anahtar yine dönmez.
    const detailed = await page.evaluate(async (secret: string) => {
      const response = await fetch("/api/health", { headers: { "X-Cron-Secret": secret } });
      return { status: response.status, text: await response.text() };
    }, E2E_CRON_SECRET);
    expect(detailed.status).toBe(200);
    const payload = JSON.parse(detailed.text) as { data: { providers: { providerCode: string }[] } };
    expect(payload.data.providers.length).toBeGreaterThan(0);
    expect(detailed.text).not.toContain(E2E_CRON_SECRET);
    expect(detailed.text).not.toContain("API_URL");
    expect(detailed.text.toLowerCase()).not.toContain("apikey");

    // Yanlış secret ayrıntı açmaz.
    const wrong = await page.evaluate(async () => {
      const response = await fetch("/api/health", { headers: { "X-Cron-Secret": "yanlis" } });
      return (await response.json()) as { data: Record<string, unknown> };
    });
    expect(wrong.data.providers).toBeUndefined();
  });

  test("kullanıcı verisini CSV indirebilir ve silme talebi gönderebilir", async ({ page }) => {
    const username = scopedUsername("veridisa");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "1",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });

    const csv = await page.evaluate(async () => {
      const response = await fetch("/api/portfolio/export?tur=islem");
      return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
    });
    expect(csv.status).toBe(200);
    expect(csv.type).toContain("text/csv");
    expect(csv.body).toContain("Girilen birim fiyat");
    expect(csv.body).toContain("Gram Altın");

    const request = await browserApi<{ message: string }>(page, "POST", "/api/account/deletion-request", {
      reason: "test",
    });
    expect(request.status).toBe(201);
    expect(request.data?.message).toContain("yönetici onayıyla");

    await gotoReady(page, "/gizlilik");
    await expect(page.getByText("Bağlayıcı bir alım satım teklifi değildir.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("yönetici ikinci faktörü", () => {
  test("MFA doğrulanmadan yönetim uçları reddedilir", async ({ page }) => {
    // Girişten sonra MFA ekranına yönlendirilir; doğrulama yapılmadan admin API'si çalışmaz.
    await gotoReady(page, "/giris");
    await page.getByLabel("Kullanıcı adı").fill(ADMIN.username);
    await page.getByLabel("Parola", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await page.waitForURL(/guvenlik/, { timeout: 30_000 });
    await expect(page.getByTestId("mfa-view")).toBeVisible();

    const denied = await browserApi(page, "GET", "/api/admin/users");
    expect(denied.status).toBe(403);
    const deniedSources = await browserApi(page, "GET", "/api/admin/price-sources");
    expect(deniedSources.status).toBe(403);
    await expectNoHorizontalOverflow(page);
  });

  test("normal kullanıcı ikinci faktör olmadan çalışır", async ({ page }) => {
    const username = scopedUsername("mfasiz");
    await createReadyUser(username);
    await loginAsUser(page, username);
    const status = await browserApi<{ required: boolean; state: string }>(page, "GET", "/api/auth/mfa");
    expect(status.data?.required).toBe(false);
    expect(status.data?.state).toBe("not_required");
    expect((await browserApi(page, "GET", "/api/portfolio")).status).toBe(200);
  });
});
