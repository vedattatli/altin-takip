import { expect, test, type Page } from "@playwright/test";

import { LocalAuthBackend } from "../src/server/auth/local-backend";
import { E2E_STORE_FILE } from "./global-setup";

export const TEST_PASSWORD = "Kuyumcu7Defter";

/**
 * Testler üç ekran genişliği için sırayla çalışır ve aynı yerel veri dosyasını
 * paylaşır. Kullanıcı adına proje adı eklenerek her koşum kendi hesabını kullanır.
 */
export function scopedUsername(base: string): string {
  return `${base}.${test.info().project.name}`;
}

function backend(): LocalAuthBackend {
  return new LocalAuthBackend({ fileName: E2E_STORE_FILE });
}

/** Test için hazır (parola değiştirme zorunluluğu kaldırılmış) kullanıcı oluşturur. */
export async function createReadyUser(username: string, displayName = "Test Kullanıcı") {
  const store = backend();
  const existing = await store.findProfileByUsername(username);
  if (existing) return existing;

  const user = await store.createUser({
    username,
    displayName,
    temporaryPassword: TEST_PASSWORD,
    role: "user",
  });
  return store.setMustChangePassword(user.id, false);
}

/** Geçici parolalı (ilk girişte parola değiştirmesi gereken) kullanıcı oluşturur. */
export async function createPendingUser(username: string, displayName = "Yeni Kullanıcı") {
  const store = backend();
  const existing = await store.findProfileByUsername(username);
  if (existing) return existing;
  return store.createUser({
    username,
    displayName,
    temporaryPassword: TEST_PASSWORD,
    role: "user",
  });
}

/**
 * Sayfaya gider ve istemci tarafı etkileşim hazır olana kadar bekler.
 * Kök öğedeki data-hydrated işareti HydrationMarker tarafından yazılır.
 */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
}

export type DeviceChoice = "personal" | "shared";

/**
 * Giriş yapar. Cihaz türü varsayılan olarak "personal" seçilir; ortak cihaz
 * kısıtları (otomatik çıkış vb.) yalnızca e2e/device.spec.ts içinde denenir.
 */
export async function login(
  page: Page,
  username: string,
  password = TEST_PASSWORD,
  device: DeviceChoice = "personal",
) {
  await gotoReady(page, "/giris");
  await page.getByLabel("Kullanıcı adı").fill(username);
  await page.getByLabel("Parola", { exact: true }).fill(password);
  await page
    .getByRole("radio", { name: device === "personal" ? "Kişisel cihaz" : "Şirket / ortak cihaz" })
    .click();
  await page.getByRole("button", { name: "Giriş yap" }).click();
}

export async function loginAsUser(
  page: Page,
  username: string,
  password = TEST_PASSWORD,
  device: DeviceChoice = "personal",
) {
  await login(page, username, password, device);
  await page.waitForURL("**/panel");
}

/** Sayfada yatay taşma olmadığını doğrular. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(
    overflow.scrollWidth,
    `Yatay taşma: scrollWidth=${overflow.scrollWidth}, viewport=${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Yeni bir altın alış işlemi ekler. */
export async function addPurchase(
  page: Page,
  options: { product?: string; quantity: string; unitPrice: string },
) {
  await page.getByTestId("add-transaction").click();
  if (options.product) {
    await page.getByLabel("Altın türü").selectOption({ label: options.product });
  }
  await page.getByLabel(/^Miktar/).fill(options.quantity);
  await page.getByLabel(/^Birim alış fiyatı/).fill(options.unitPrice);
  await page.getByRole("button", { name: "İşlemi kaydet" }).click();
  await expect(page.getByTestId("transaction-list")).toBeVisible();
}

export interface BrowserApiResult<T = unknown> {
  status: number;
  body: T | null;
}

/**
 * API isteğini TARAYICI İÇİNDEN yapar.
 *
 * Playwright'ın `page.request` istemcisi Node tarafında çalışır ve `Secure`
 * işaretli oturum çerezini düz HTTP üzerinden göndermez. Gerçek kullanıcı
 * davranışını doğrulamak için istek sayfanın kendi bağlamından atılır.
 */
export async function browserApi<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<BrowserApiResult<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await response.json().catch(() => null);
      return { status: response.status, body: parsed };
    },
    { method, path, body: body ?? null },
  ) as Promise<BrowserApiResult<T>>;
}
