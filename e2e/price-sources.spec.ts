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

    /*
     * Ekran yalnızca değerleme planının kaynaklarını ve yöneticinin açtığı
     * kaynakları kart olarak çizer; fiyat getirmeyenler katlanmış listeye
     * iner. DÜRÜST ADLANDIRMA orada da sürer: her kaynak gerçekte okuduğu
     * ekranın/tablonun adıyla anılır, başka bir piyasanın fiyatıymış gibi
     * gösterilmez.
     */
    const disconnected = page.getByTestId("disconnected-sources");
    await disconnected.locator("summary").click();
    await expect(disconnected.getByText(/Sarraf TV Kayseri ekran gözlemi/)).toBeVisible();
    await expect(
      disconnected.getByText(/anlikaltinfiyatlari\.com — Kapalıçarşı Önerilen tablosu/),
    ).toBeVisible();
    // Harem'in resmî servisi iddiası hiçbir yerde geçmez.
    await expect(page.getByText(/Harem resmî/i)).toHaveCount(0);

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

  test("kullanıcı yalnızca açık kaynağı seçer; arayüzde kaynak seçimi yoktur ve geçmiş değişmez", async ({ page, browser }) => {
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
    /*
     * KULLANICI BAZLI KAYNAK SEÇİMİ UCU KALDIRILDI.
     *
     * Eskiden bu uç, seçilemez bir kaynak istendiğinde 409 dönerdi. Sadeleştirme
     * turunda ürün kararı değişti: kullanıcı hiçbir kaynağı seçmez, hangi ürünün
     * fiyatının nereden geleceğine değerleme planı karar verir. Uç POST kabul
     * etmiyor (405) — yani "yanlış kaynak seçme" ihtimali ortadan KALKTI, sadece
     * reddedilmiyor. Bu test o kapının kapalı kaldığını sabitler.
     */
    for (const providerCode of ["harem-direct", "bist-reference", "mock"]) {
      const attempt = await browserApi(page, "POST", "/api/price-sources", { providerCode });
      expect(attempt.status, providerCode).toBe(405);
    }

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
    // Ekran teknik sağlayıcı SEÇTİRMEZ: ne seçim düğmesi ne de onay adımı
    // vardır; kullanıcıya yalnızca fiyatların durumu gösterilir.
    await expect(page.getByTestId("active-source")).toBeVisible();
    await expect(page.getByTestId("select-mock")).toHaveCount(0);
    await expect(page.getByTestId("confirm-source-change")).toHaveCount(0);

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

    // Kullanıcı hiçbir şey seçemediği hâlde fiyat görebiliyor: kaynağı
    // yönetici belirler, kullanıcının kararına gerek yoktur.
    const after = await browserApi<{ active: { providerCode: string | null } }>(page, "GET", "/api/price-sources");
    expect(after.status).toBe(200);

    await adminContext.close();
  });

  test("fiyat ekranı güncelliği söyler; test verisi panelde etiketli kalır", async ({ page, browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage, ADMIN.username, ADMIN.password);
    await browserApi(adminPage, "PATCH", "/api/admin/price-sources/mock", { enabled: true, userSelectable: true });
    await browserApi(adminPage, "POST", "/api/admin/price-sources/mock/refresh");

    /*
     * GLOBAL VARSAYILAN KAYNAK — BU TESTİN SONUNDA GERİ ALINIR.
     *
     * Kullanıcı artık kaynak SEÇMEZ; kendi tercihi olmayan herkes yöneticinin
     * global varsayılanını kullanır. Bu ayar depoda GLOBALDİR: açık bırakılırsa
     * sonraki spec'lerdeki kullanıcılar da "mock" kaydına bağlanır, o kayıtlar
     * bayatlar ve o testler fiyatsız kalır. Bu yüzden `finally` ile temizlenir.
     */
    await browserApi(adminPage, "PUT", "/api/admin/price-sources/default", { providerCode: "mock" });

    try {
      const username = scopedUsername("kaynakpanel");
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

      /*
       * Kaynak ekranının kullanıcıyı ilgilendiren tek bilgisi fiyatların ne
       * kadar güncel olduğudur: durum etiketi ve son güncelleme zamanı. Kaynak
       * yeni tazelendiği için durum "Güncel" olmak ZORUNDADIR; "Güncel değil"
       * de aynı kelimeyi taşıdığından beklenti satırın tamamına bakar.
       */
      await gotoReady(page, "/fiyat-kaynagi");
      await expect(page.getByTestId("active-source")).toHaveText(/^Güncel · Son güncelleme \d/);

      // Test verisi panelde "gerçek piyasa verisi değil" diye etiketli kalır.
      await gotoReady(page, "/panel");
      await expect(page.getByTestId("price-source").getByText("Gerçek piyasa verisi değil")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    } finally {
      await browserApi(adminPage, "PUT", "/api/admin/price-sources/default", { providerCode: "" });
      await adminContext.close();
    }
  });

  test("zamanlanmış alım ucu: secret olmadan 403, secret ile CSRF çerezi OLMADAN çalışır", async ({
    page,
    request,
  }) => {
    const username = scopedUsername("cronucu");
    await createReadyUser(username);
    await loginAsUser(page, username);
    const denied = await browserApi(page, "POST", "/api/cron/price-ingestion");
    expect(denied.status).toBe(403);

    // Zamanlayıcı gibi davran: tarayıcı bağlamı, çerez ve CSRF jetonu YOK.
    const wrong = await request.post("/api/cron/price-ingestion", {
      headers: { Authorization: "Bearer yanlis-secret" },
    });
    expect(wrong.status()).toBe(403);

    const accepted = await request.post("/api/cron/price-ingestion", {
      headers: { Authorization: `Bearer ${E2E_CRON_SECRET}` },
    });
    expect(accepted.status()).toBe(200);
    const body = (await accepted.json()) as { data: { runKey: string; providers: unknown[] } };
    expect(body.data.runKey).toContain("price-ingestion:");
    expect(Array.isArray(body.data.providers)).toBe(true);
    // Makine yanıtı çerez yazmaz ve secret sızdırmaz.
    expect(accepted.headers()["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(E2E_CRON_SECRET);

    // Aynı dakikadaki tekrar çağrı aynı koşum anahtarını kullanır (idempotent).
    const again = await request.post("/api/cron/price-ingestion", {
      headers: { "X-Cron-Secret": E2E_CRON_SECRET },
    });
    expect(again.status()).toBe(200);
    const secondBody = (await again.json()) as { data: { runKey: string } };
    expect(secondBody.data.runKey).toBe(body.data.runKey);
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
    // Silme talebinin ne olacağı kullanıcıya gizlilik sayfasında da yazılır.
    await expect(page.getByText(/yönetici onayıyla kalıcı olarak silinir/)).toBeVisible();
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
