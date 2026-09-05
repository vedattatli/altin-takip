import { expect, test } from "@playwright/test";

import { ADMIN } from "./global-setup";
import {
  addPurchase,
  login,
  loginAsAdmin,
  browserApi,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  loginAsUser,
  scopedUsername,
  TEST_PASSWORD,
} from "./helpers";

/** Yönetici girişi + ikinci faktör (panel MFA olmadan açılmaz). */
async function signInAsAdmin(page: import("@playwright/test").Page) {
  await loginAsAdmin(page, ADMIN.username, ADMIN.password);
}

test.describe("yönetim paneli", () => {
  test("yönetici kullanıcı listesini görür", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByRole("link", { name: "Yönetim" }).first().click();
    await page.waitForURL("**/yonetim");

    await expect(page.getByRole("heading", { name: "Yönetim" })).toBeVisible();
    await expect(page.getByTestId("user-list")).toBeVisible();
    await expect(page.getByTestId("user-list")).toContainText(ADMIN.username);
    await expectNoHorizontalOverflow(page);
  });

  test("yönetici yeni kullanıcı oluşturur ve kullanıcı ilk girişte parola değiştirir", async ({
    page,
  }) => {
    const username = scopedUsername("panelden");
    const temporaryPassword = "GeciciParola7Kasa";

    await signInAsAdmin(page);
    await gotoReady(page, "/yonetim");

    await page.getByTestId("open-create-user").click();
    await page.getByLabel("Kullanıcı adı").fill(username);
    await page.getByLabel("Görünen ad").fill("Panelden Oluşturuldu");
    await page.getByLabel("Geçici parola").fill(temporaryPassword);
    await page.getByRole("button", { name: "Kullanıcıyı oluştur" }).click();

    await expect(page.getByText("Kullanıcı oluşturuldu")).toBeVisible();
    await expect(page.getByTestId("user-list")).toContainText(username);

    // Yeni kullanıcı ilk girişte parola değiştirme ekranına yönlenir.
    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");
    await login(page, username, temporaryPassword);
    await page.waitForURL("**/parola-degistir");
    await expect(page.getByText("Parolanızı değiştirmeniz gerekiyor")).toBeVisible();
  });

  test("aynı kullanıcı adı farklı harflerle oluşturulamaz", async ({ page }) => {
    const username = scopedUsername("kopyaad");
    await createReadyUser(username);

    await signInAsAdmin(page);
    await gotoReady(page, "/yonetim");
    await page.getByTestId("open-create-user").click();
    await page.getByLabel("Kullanıcı adı").fill(username.toUpperCase());
    await page.getByLabel("Görünen ad").fill("Kopya Deneme");
    await page.getByLabel("Geçici parola").fill("GeciciParola7Kasa");
    await page.getByRole("button", { name: "Kullanıcıyı oluştur" }).click();

    await expect(page.getByTestId("alert-danger")).toContainText("zaten kullanılıyor");
  });

  test("yönetici kullanıcı arar", async ({ page }) => {
    const username = scopedUsername("aranan");
    await createReadyUser(username, "Aranan Kişi");

    await signInAsAdmin(page);
    await gotoReady(page, "/yonetim");
    await page.getByLabel("Kullanıcı ara").fill(username);

    await expect(page.getByTestId("user-list")).toContainText(username);
    await expect(page.getByTestId("user-list")).not.toContainText(ADMIN.username);
  });

  /*
   * Yönetici kullanıcının ALTIN VARLIĞINI GÖREMEZ (ürün kararı).
   * Bu test eskiden yöneticinin portföyü doğru gördüğünü sınıyordu; artık
   * HİÇ görmediğini sınıyor.
   */
  test("yönetici kullanıcının altın varlığını göremez; giriş/oturum bilgisini görür", async ({
    page,
    browser,
  }) => {
    const username = scopedUsername("portfoygoruntu");
    const target = await createReadyUser(username);

    // Kullanıcı kendi hesabına altın ekler.
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await loginAsUser(userPage, username);
    // Deterministik başlangıç: kullanıcının önceki kayıtları temizlenir.
    await browserApi(userPage, "DELETE", "/api/transactions");
    await gotoReady(userPage, "/islemler");
    await addPurchase(userPage, { product: "gram-altin", quantity: "8", unitPrice: "5000" });
    await userContext.close();

    await signInAsAdmin(page);
    // Arama akışı ayrı bir testte doğrulanır; burada kullanıcıya doğrudan gidilir.
    await gotoReady(page, `/yonetim/${target.id}`);

    // Finansal içerik HİÇBİR biçimde görünmemeli.
    await expect(page.getByText("Kullanıcının portföyü")).toHaveCount(0);
    await expect(page.getByText("Elde kalan maliyet")).toHaveCount(0);
    await expect(page.getByText("40.000,00")).toHaveCount(0);
    await expect(page.getByText("Gram Altın")).toHaveCount(0);

    // Hesap yaşam döngüsü görünmeye devam eder.
    await expect(page.getByText(username)).toBeVisible();
    await expect(page.getByText("Aktif oturumlar")).toBeVisible();

    // Uç de silinmiştir: doğrudan istek 404 döner.
    const status = await page.evaluate(
      async (id) => (await fetch(`/api/admin/users/${id}/portfolio`)).status,
      target.id,
    );
    expect(status).toBe(404);

    await expectNoHorizontalOverflow(page);
  });

  test("yönetici kullanıcıyı pasifleştirir; pasif kullanıcı giriş yapamaz", async ({ page }) => {
    const username = scopedUsername("pasiflestir");
    const user = await createReadyUser(username);

    await signInAsAdmin(page);
    await gotoReady(page, `/yonetim/${user.id}`);
    await page.getByTestId("deactivate-user").click();
    await expect(page.getByText(/pasifleştirildi/)).toBeVisible();

    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");
    await login(page, username, TEST_PASSWORD);
    await expect(page.getByTestId("alert-danger")).toContainText("Kullanıcı adı veya parola hatalı.");
  });

  test("yönetici kullanıcıyı yeniden aktifleştirir", async ({ page }) => {
    const username = scopedUsername("aktiflestir");
    const user = await createReadyUser(username);

    await signInAsAdmin(page);
    await gotoReady(page, `/yonetim/${user.id}`);
    await page.getByTestId("deactivate-user").click();
    await expect(page.getByText(/pasifleştirildi/)).toBeVisible();

    await page.getByTestId("activate-user").click();
    await expect(page.getByText(/yeniden aktifleştirildi/)).toBeVisible();

    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");
    await login(page, username, TEST_PASSWORD);
    await page.waitForURL("**/panel");
  });

  test("yönetici parola sıfırlar; eski parola geçersiz olur", async ({ page }) => {
    const username = scopedUsername("sifirlama");
    const user = await createReadyUser(username);
    const newTemporary = "SifirlananP7Kasa";

    await signInAsAdmin(page);
    await gotoReady(page, `/yonetim/${user.id}`);
    await page.getByTestId("open-reset-password").click();

    // Yönetici mevcut parolayı göremez; form bunu açıkça belirtir.
    await expect(page.getByText(/mevcut parolasını göremezsiniz/)).toBeVisible();

    await page.getByLabel("Yeni geçici parola").fill(newTemporary);
    await page.getByTestId("submit-reset-password").click();

    await expect(page.getByText(/Geçici parola atandı/)).toBeVisible();

    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");

    await login(page, username, TEST_PASSWORD);
    await expect(page.getByTestId("alert-danger")).toContainText("Kullanıcı adı veya parola hatalı.");

    await gotoReady(page, "/giris");
    await login(page, username, newTemporary);
    await page.waitForURL("**/parola-degistir");
  });

  test("kalıcı silme açık onay olmadan çalışmaz", async ({ page }) => {
    const username = scopedUsername("silinecek");
    const user = await createReadyUser(username);

    await signInAsAdmin(page);
    await gotoReady(page, `/yonetim/${user.id}`);
    await page.getByTestId("open-delete-user").click();

    await expect(page.getByText("Bu işlem geri alınamaz")).toBeVisible();
    await expect(page.getByText(/hesabı, portföyü ve/)).toBeVisible();

    // Yanlış onay metni silmeyi engeller.
    await page.getByLabel(/Onaylamak için kullanıcı adını yazın/).fill("yanlisad");
    await page.getByTestId("confirm-delete-user").click();
    await expect(page.getByText(/Silme onayı eşleşmedi/)).toBeVisible();

    // Doğru onay metni ile silme tamamlanır.
    await page.getByLabel(/Onaylamak için kullanıcı adını yazın/).fill(username);
    await page.getByTestId("confirm-delete-user").click();
    await page.waitForURL("**/yonetim");
    await expect(page.getByTestId("user-list")).not.toContainText(username);
  });
});

test.describe("yetkilendirme", () => {
  test("normal kullanıcı yönetim ekranına erişemez", async ({ page }) => {
    const username = scopedUsername("yetkisiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    // Menüde yönetim bağlantısı görünmez...
    await expect(page.getByRole("link", { name: "Yönetim" })).toHaveCount(0);

    // ...ve doğrudan adres yazıldığında da erişemez.
    await gotoReady(page, "/yonetim");
    await page.waitForURL("**/panel");
  });

  test("normal kullanıcı yönetim API uçlarına erişemez", async ({ page }) => {
    const username = scopedUsername("apiyetkisiz");
    await createReadyUser(username);
    await loginAsUser(page, username);

    const list = await browserApi(page, "GET", "/api/admin/users");
    expect(list.status).toBe(403);

    const audit = await browserApi(page, "GET", "/api/admin/audit");
    expect(audit.status).toBe(403);

    const create = await browserApi(page, "POST", "/api/admin/users", {
      username: "yenihesap",
      displayName: "Yeni Hesap",
      temporaryPassword: TEST_PASSWORD,
    });
    expect(create.status).toBe(403);
  });

  test("kullanıcı kendisini yönetici yapamaz", async ({ page }) => {
    const username = scopedUsername("rolyukseltme");
    await createReadyUser(username);
    await loginAsUser(page, username);

    // Rol alanı hiçbir uçta kabul edilmez.
    const attempt = await browserApi(page, "POST", "/api/admin/users", {
      username: scopedUsername("sahteadmin"),
      displayName: "Sahte Yönetici",
      temporaryPassword: TEST_PASSWORD,
      role: "admin",
    });
    expect(attempt.status).toBe(403);

    /*
     * Rol rozeti Ayarlar ekranından KALDIRILDI (arayüz sadeleştirmesi); rol
     * artık kullanıcıya hiçbir yerde etiket olarak gösterilmiyor. Doğrulanan
     * davranış aynı kalır: denemeden sonra hesap hâlâ NORMAL kullanıcıdır.
     * Rol, ekrandaki etiket yerine oturum ucundan okunur.
     */
    const session = await browserApi<{ user: { role: string } | null }>(
      page,
      "GET",
      "/api/auth/session",
    );
    expect(session.status).toBe(200);
    expect(session.data?.user?.role).toBe("user");
  });

  test("oturumsuz istek yönetim uçlarına erişemez", async ({ request }) => {
    const response = await request.get("/api/admin/users");
    expect(response.status()).toBe(401);
  });

  test("yönetici işlemleri denetim kaydı oluşturur", async ({ page }) => {
    const username = scopedUsername("denetim");
    const user = await createReadyUser(username);

    await signInAsAdmin(page);
    await gotoReady(page, `/yonetim/${user.id}`);
    // Yönetici portföy GÖRMEZ; görüntülenen şey hesabın kendisidir.
    await expect(page.getByText("Aktif oturumlar")).toBeVisible();

    const response = await browserApi<{ action: string; targetUsername: string | null }[]>(
      page,
      "GET",
      "/api/admin/audit?limit=50",
    );
    expect(response.status).toBe(200);
    const rows = response.data!;

    const entries = rows.filter((row) => row.targetUsername === username);
    expect(entries.some((row) => row.action === "user.account_view")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(TEST_PASSWORD);
  });
});
