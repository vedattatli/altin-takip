import { expect, test } from "@playwright/test";

import {
  createPendingUser,
  createReadyUser,
  expectNoHorizontalOverflow,
  gotoReady,
  login,
  scopedUsername,
  TEST_PASSWORD,
} from "./helpers";

test.describe("giriş ekranı", () => {
  test("yalnızca kullanıcı adı ve parola sorar", async ({ page }) => {
    await gotoReady(page, "/giris");

    await expect(page.getByRole("heading", { name: "Altın Takip" })).toBeVisible();
    await expect(page.getByLabel("Kullanıcı adı")).toBeVisible();
    await expect(page.getByLabel("Parola", { exact: true })).toBeVisible();

    // E-posta / telefon / OTP alanı YOKTUR.
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.locator('input[type="tel"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);

    // KAYIT ARTIK HERKESE AÇIK.
    //
    // Eskiden hesapları yalnızca yönetici açardı ve bu ekranda kayıt bağlantısı
    // BULUNMAZDI; test de bunu doğrulardı. Ürün kararı değişti (bkz.
    // src/app/api/auth/register/route.ts), giriş ekranı artık kayıt sayfasına
    // bağlantı veriyor. Beklenti bağlantının adresine bakar: metin kısalsa bile
    // kullanıcının kayıt sayfasına ulaşabildiği doğrulanmaya devam eder.
    await expect(page.getByRole("link", { name: "Hesap oluşturun" })).toHaveAttribute(
      "href",
      "/kayit",
    );
  });

  test("parola göster/gizle düğmesi çalışır", async ({ page }) => {
    await gotoReady(page, "/giris");
    const password = page.getByLabel("Parola", { exact: true });

    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Göster" }).click();
    await expect(password).toHaveAttribute("type", "text");
  });

  test("hatalı girişte ayrım yapmayan genel mesaj gösterir", async ({ page }) => {
    const username = scopedUsername("hatatest");
    await createReadyUser(username);

    await login(page, username, "YanlisParola1");
    const wrongPassword = await page.getByTestId("alert-danger").textContent();

    await gotoReady(page, "/giris");
    await login(page, "olmayankullanici", "HerhangiParola1");
    const unknownUser = await page.getByTestId("alert-danger").textContent();

    expect(wrongPassword).toContain("Kullanıcı adı veya parola hatalı.");
    expect(unknownUser).toBe(wrongPassword);
  });

  test("giriş yapmadan panele erişilemez", async ({ page }) => {
    await gotoReady(page, "/panel");
    await page.waitForURL("**/giris");
    await expect(page.getByLabel("Kullanıcı adı")).toBeVisible();
  });

  test("giriş yapmadan yönetim ekranına erişilemez", async ({ page }) => {
    await gotoReady(page, "/yonetim");
    await page.waitForURL("**/giris");
  });

  test("yatay taşma yoktur", async ({ page }) => {
    await gotoReady(page, "/giris");
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("ilk giriş ve parola değiştirme", () => {
  test("geçici parolalı kullanıcı parola değiştirme ekranına yönlendirilir", async ({ page }) => {
    const username = scopedUsername("gecicikullanici");
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");
    await expect(page.getByText("Parolanızı değiştirmeniz gerekiyor")).toBeVisible();

    // Parola değiştirmeden panele geçemez.
    await gotoReady(page, "/panel");
    await page.waitForURL("**/parola-degistir");
    await expectNoHorizontalOverflow(page);
  });

  test("parola değiştirdikten sonra yeni parolayla giriş yapılır", async ({ page }) => {
    const username = scopedUsername("parolatest");
    const newPassword = "YeniParola7Kasa";
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    await page.getByLabel("Mevcut parola").fill(TEST_PASSWORD);
    await page.getByLabel("Yeni parola", { exact: true }).fill(newPassword);
    await page.getByLabel("Yeni parola (tekrar)").fill(newPassword);
    await page.getByRole("button", { name: "Parolayı değiştir" }).click();

    await expect(page.getByText("Parolanız güncellendi")).toBeVisible();
    // Bu cihazdaki oturum sürer; yeniden giriş gerekmez.
    await page.waitForURL("**/panel", { timeout: 15_000 });

    // Açıkça çıkış yapılır ve eski parola artık çalışmaz.
    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");
    await login(page, username, TEST_PASSWORD);
    await expect(page.getByTestId("alert-danger")).toContainText("Kullanıcı adı veya parola hatalı.");

    // Yeni parola çalışır.
    await gotoReady(page, "/giris");
    await login(page, username, newPassword);
    await page.waitForURL("**/panel");
  });

  test("zayıf parola reddedilir", async ({ page }) => {
    const username = scopedUsername("zayifparola");
    await createPendingUser(username);

    await login(page, username);
    await page.waitForURL("**/parola-degistir");

    await page.getByLabel("Mevcut parola").fill(TEST_PASSWORD);
    await page.getByLabel("Yeni parola", { exact: true }).fill("kisa1");
    await page.getByLabel("Yeni parola (tekrar)").fill("kisa1");
    await page.getByRole("button", { name: "Parolayı değiştir" }).click();

    await expect(page.getByTestId("alert-danger")).toContainText("en az 10 karakter");
  });
});

test.describe("çıkış", () => {
  test("çıkış yapınca oturum kapanır", async ({ page }) => {
    const username = scopedUsername("cikistest");
    await createReadyUser(username);

    await login(page, username);
    await page.waitForURL("**/panel");

    await page.getByRole("button", { name: "Çıkış" }).click();
    await page.waitForURL("**/giris");

    await gotoReady(page, "/panel");
    await page.waitForURL("**/giris");
  });
});
