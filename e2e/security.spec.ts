import { expect, test } from "@playwright/test";

import { ADMIN } from "./global-setup";
import {
  loginAsAdmin,
  browserApi,
  createPendingUser,
  createReadyUser,
  expireSessionsOnServer,
  gotoReady,
  login,
  loginAsUser,
  revokeSessionsOnServer,
  scopedUsername,
  TEST_PASSWORD,
} from "./helpers";

/**
 * Sprint 0.5 güvenlik senaryoları — gerçek tarayıcıda, üretim derlemesine karşı.
 */

test.describe("geçici parola sunucu koruması", () => {
  test("geçici parolalı kullanıcı portföy API'sine erişemez", async ({ page }) => {
    const username = scopedUsername("gecicikoruma");
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    // UI yönlendirmesi tek koruma değildir: API de reddeder.
    for (const path of ["/api/portfolio", "/api/transactions"]) {
      const response = await browserApi(page, "GET", path);
      expect(response.status, path).toBe(403);
      expect(response.code, path).toBe("PASSWORD_CHANGE_REQUIRED");
    }

    const created = await browserApi(page, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "1",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });
    expect(created.status).toBe(403);
  });

  test("geçici parolalı kullanıcı yönetim API'sine de erişemez", async ({ page }) => {
    const username = scopedUsername("gecicadmin");
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    const response = await browserApi(page, "GET", "/api/admin/users");
    expect(response.status).toBe(403);
  });

  test("oturum ve parola değiştirme uçları geçici parolalı kullanıcıya açıktır", async ({
    page,
  }) => {
    const username = scopedUsername("gecicisession");
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    const session = await browserApi<{ user: { mustChangePassword: boolean } }>(
      page,
      "GET",
      "/api/auth/session",
    );
    expect(session.status).toBe(200);
    expect(session.data?.user.mustChangePassword).toBe(true);
  });

  test("parola değiştirince bu cihazın oturumu sürer, diğer cihazlar kapanır", async ({
    page,
    browser,
  }) => {
    const username = scopedUsername("yenidengiris");
    const newPassword = "YepyeniParola7Kasa";
    await createPendingUser(username);

    // İkinci cihaz: aynı hesapla başka bir tarayıcı bağlamı.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await login(otherPage, username);
    await otherPage.waitForURL("**/parola-degistir");

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    await page.getByLabel("Mevcut parola").fill(TEST_PASSWORD);
    await page.getByLabel("Yeni parola", { exact: true }).fill(newPassword);
    await page.getByLabel("Yeni parola (tekrar)").fill(newPassword);
    await page.getByRole("button", { name: "Parolayı değiştir" }).click();

    // Bu cihazda yeniden giriş GEREKMEZ.
    await page.waitForURL("**/panel", { timeout: 20_000 });
    const session = await browserApi<{ user: { username: string } }>(
      page,
      "GET",
      "/api/auth/session",
    );
    expect(session.data?.user.username).toBe(username);

    // Diğer cihazın oturumu güvenlik için kapatılmıştır.
    const other = await browserApi<{ user: unknown }>(otherPage, "GET", "/api/auth/session");
    expect(other.data?.user).toBeNull();
    await otherContext.close();
  });
});

test.describe("sunucu tarafı oturum geçerliliği", () => {
  test("kaydırmalı ömrü dolan oturum sunucuda reddedilir", async ({ page }) => {
    const username = scopedUsername("suresigecen");
    await createReadyUser(username);

    await loginAsUser(page, username);

    // 180 günlük ömrün dolduğu durum sunucu kaydında simüle edilir.
    const expired = await expireSessionsOnServer(username);
    expect(expired).toBeGreaterThan(0);

    const response = await browserApi(page, "GET", "/api/portfolio");
    expect(response.status).toBe(401);

    await gotoReady(page, "/panel");
    await page.waitForURL("**/giris");
  });

  test("iptal edilmiş (revoke) oturum çerezi ile erişim reddedilir", async ({ page }) => {
    const username = scopedUsername("iptaledilen");
    await createReadyUser(username);

    await loginAsUser(page, username);
    expect(await revokeSessionsOnServer(username)).toBeGreaterThan(0);

    // Çerez tarayıcıda duruyor ama sunucu kaydı iptal edilmiştir.
    const response = await browserApi(page, "GET", "/api/transactions");
    expect(response.status).toBe(401);
  });
});

test.describe("CSRF ve origin koruması", () => {
  test("CSRF jetonu olmayan mutation reddedilir", async ({ page }) => {
    const username = scopedUsername("csrfsiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const response = await browserApi(
      page,
      "PATCH",
      "/api/portfolio",
      { name: "Ele geçirildi" },
      { csrf: "omit" },
    );
    expect(response.status).toBe(403);
    expect(response.code).toBe("csrf_rejected");
  });

  test("geçersiz CSRF jetonu reddedilir", async ({ page }) => {
    const username = scopedUsername("csrfgecersiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const response = await browserApi(
      page,
      "PATCH",
      "/api/portfolio",
      { name: "Ele geçirildi" },
      { csrf: "invalid" },
    );
    expect(response.status).toBe(403);
  });

  test("geçerli CSRF jetonu ile mutation kabul edilir", async ({ page }) => {
    const username = scopedUsername("csrfgecerli");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const response = await browserApi(page, "PATCH", "/api/portfolio", {
      name: "Benim Portföyüm",
    });
    expect(response.status).toBe(200);
  });

  test("okuma istekleri CSRF jetonu gerektirmez", async ({ page }) => {
    const username = scopedUsername("csrfokuma");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const response = await browserApi(page, "GET", "/api/portfolio", undefined, { csrf: "omit" });
    expect(response.status).toBe(200);
  });

  test("farklı origin'den gelen mutation reddedilir", async ({ request }) => {
    // Tarayıcı Origin başlığını değiştirmeye izin vermez; bu yüzden istek
    // Node tarafındaki istemciyle, sahte Origin başlığıyla atılır.
    const response = await request.post("/api/auth/logout", {
      headers: { Origin: "https://kotu-site.example", "Sec-Fetch-Site": "cross-site" },
    });

    expect(response.status()).toBe(403);
    const payload = (await response.json()) as { error?: string; code?: string };
    expect(payload.code).toBe("csrf_rejected");
    expect(payload.error).toContain("beklenen adresten");
  });

  test("aynı origin ama CSRF jetonsuz istek de reddedilir", async ({ request, baseURL }) => {
    const response = await request.post("/api/auth/logout", {
      headers: { Origin: baseURL!, "Sec-Fetch-Site": "same-origin" },
    });

    expect(response.status()).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("csrf_rejected");
  });

  test("CSRF jetonu sayfada meta etiketiyle taşınır, depoya yazılmaz", async ({ page }) => {
    const username = scopedUsername("csrfmeta");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const state = await page.evaluate(() => ({
      meta: document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? null,
      cookieVisible: document.cookie.includes("csrf"),
      localStorageEntries: Object.entries(localStorage).map(([key, value]) => `${key}=${String(value)}`),
      sessionStorageKeys: Object.keys(sessionStorage).length,
    }));

    expect(state.meta).toMatch(/^[0-9a-f]{64}$/);
    // Çerez HttpOnly olduğu için JavaScript göremez.
    expect(state.cookieVisible).toBe(false);
    /*
     * Tarayıcı deposunda YALNIZCA görünüm modu tercihi bulunabilir
     * ("basit" / "detaylı"). Kimlik bilgisi, oturum jetonu, CSRF jetonu veya
     * portföy verisi hiçbir koşulda yazılmaz — asıl güvence budur.
     */
    expect(state.localStorageEntries).toEqual(
      state.localStorageEntries.filter((entry) => /^altin-takip:gorunum-modu=(basit|detayli)$/.test(entry)),
    );
    expect(state.localStorageEntries.length).toBeLessThanOrEqual(1);
    expect(state.sessionStorageKeys).toBe(0);
  });
});

test.describe("kullanıcı verisi izolasyonu (API)", () => {
  test("Kullanıcı A, Kullanıcı B kaydına API üzerinden ulaşamaz", async ({ page, browser }) => {
    const userA = scopedUsername("izoapi.a");
    const userB = scopedUsername("izoapi.b");
    await createReadyUser(userA);
    await createReadyUser(userB);

    // B kendi hesabında bir işlem oluşturur.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginAsUser(pageB, userB);
    const createdB = await browserApi<{ entry: { id: string } }>(pageB, "POST", "/api/transactions", {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "4",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "5000",
    });
    expect(createdB.status).toBe(201);
    const transactionId = createdB.data!.entry.id;
    await contextB.close();

    // A oturumuyla B'nin kaydına erişmeye çalışılır (kimlik tahmini).
    await loginAsUser(page, userA);

    const listed = await browserApi<{ id: string }[]>(page, "GET", "/api/transactions");
    expect(listed.status).toBe(200);
    expect(listed.data).toHaveLength(0);

    const replaced = await browserApi(page, "PUT", `/api/transactions/${transactionId}`, {
      kind: "BUY",
      productId: "gram-altin",
      quantity: "999",
      occurredAt: "2026-01-10",
      pricingInputMode: "UNIT_PRICE",
      unitPrice: "1",
    });
    expect(replaced.status).toBe(404);

    const voided = await browserApi(page, "DELETE", `/api/transactions/${transactionId}`, { reason: "x" });
    expect(voided.status).toBe(404);
  });

  test("normal kullanıcı yönetim uçlarına erişemez", async ({ page }) => {
    const username = scopedUsername("apiyetki");
    await createReadyUser(username);
    await loginAsUser(page, username);

    for (const path of ["/api/admin/users", "/api/admin/audit"]) {
      const response = await browserApi(page, "GET", path);
      expect(response.status, path).toBe(403);
    }
  });

  test("oturumsuz istek reddedilir", async ({ request }) => {
    expect((await request.get("/api/portfolio")).status()).toBe(401);
    expect((await request.get("/api/admin/users")).status()).toBe(401);
  });
});

test.describe("güvenlik başlıkları", () => {
  test("yanıtlar beklenen güvenlik başlıklarını taşır", async ({ page }) => {
    const response = await page.goto("/giris");
    const headers = response!.headers();

    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("uygulama CSP altında sorunsuz çalışır", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });

    const username = scopedUsername("cspkontrol");
    await createReadyUser(username);
    await loginAsUser(page, username);
    await gotoReady(page, "/islemler");

    expect(violations).toEqual([]);
  });
});

test.describe("yönetim akışı CSRF ile çalışır", () => {
  test("yönetici kullanıcı oluşturabilir", async ({ page }) => {
    await loginAsAdmin(page, ADMIN.username, ADMIN.password);
    await page.waitForURL("**/panel");
    await gotoReady(page, "/yonetim");

    const username = scopedUsername("csrfadmin");
    const response = await browserApi(page, "POST", "/api/admin/users", {
      username,
      displayName: "CSRF ile Oluşturuldu",
      temporaryPassword: "GeciciParola7Kasa",
    });

    expect(response.status).toBe(201);
  });
});
