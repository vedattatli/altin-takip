import { afterEach, describe, expect, it, vi } from "vitest";

import { expectedOrigins } from "@/server/security/origins";

function headersOf(values: Record<string, string>) {
  return new Headers(values);
}

/**
 * Üretimde APP_ORIGIN ZORUNLUDUR. Host / X-Forwarded-Host istemci tarafından
 * belirlenebildiği için üretimde bu başlıklardan origin türetilmez; eksikse
 * durum değiştiren istekler fail-closed reddedilir.
 */
describe("beklenen origin — üretim", () => {
  it("APP_ORIGIN yokken Host / X-Forwarded-Host'tan TÜRETİLMEZ", () => {
    const headers = headersOf({
      host: "altin.example",
      "x-forwarded-host": "kotu.example",
      "x-forwarded-proto": "https",
    });
    expect(expectedOrigins(headers, "", true)).toEqual([]);
  });

  it("APP_ORIGIN varsa yalnızca o kabul edilir; sondaki eğik çizgi temizlenir", () => {
    const headers = headersOf({ host: "kotu.example" });
    expect(expectedOrigins(headers, "https://altin.example///", true)).toEqual([
      "https://altin.example",
    ]);
  });

  it("geliştirmede başlıktan türetme yalnızca kolaylık olarak sürer", () => {
    expect(
      expectedOrigins(headersOf({ host: "localhost:3000", "x-forwarded-proto": "http" }), "", false),
    ).toEqual(["http://localhost:3000"]);
  });
});

describe("apiRoute — üretimde APP_ORIGIN zorunluluğu", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadRouteModule(appOrigin: string) {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", appOrigin);
    vi.stubEnv("AUTH_CSRF_SECRET", "test-csrf-secret-uretim-simulasyonu");
    vi.stubEnv("RATE_LIMIT_PEPPER", "test-pepper");
    vi.resetModules();
    return import("@/server/security/route");
  }

  it("APP_ORIGIN tanımsızsa mutation 'misconfigured' ile reddedilir (fail closed)", async () => {
    const { assertRequestIsSafe } = await loadRouteModule("");
    const request = new Request("https://altin.example/api/portfolio", {
      method: "PATCH",
      headers: {
        host: "altin.example",
        origin: "https://altin.example",
        "sec-fetch-site": "same-origin",
      },
    });
    await expect(assertRequestIsSafe(request)).rejects.toMatchObject({
      code: "misconfigured",
      status: 500,
    });
  });

  it("APP_ORIGIN tanımlıysa farklı origin reddedilir, aynı origin CSRF kontrolüne geçer", async () => {
    const { assertRequestIsSafe } = await loadRouteModule("https://altin.example");

    const foreign = new Request("https://altin.example/api/portfolio", {
      method: "PATCH",
      headers: { origin: "https://kotu.example", "sec-fetch-site": "cross-site" },
    });
    await expect(assertRequestIsSafe(foreign)).rejects.toMatchObject({ code: "csrf_rejected" });

    // Doğru origin ama CSRF jetonu yok: yine reddedilir (ikinci katman).
    const sameOrigin = new Request("https://altin.example/api/portfolio", {
      method: "PATCH",
      headers: { origin: "https://altin.example", "sec-fetch-site": "same-origin" },
    });
    await expect(assertRequestIsSafe(sameOrigin)).rejects.toMatchObject({ code: "csrf_rejected" });
  });

  it("okuma istekleri APP_ORIGIN'den bağımsız olarak geçer", async () => {
    const { assertRequestIsSafe } = await loadRouteModule("");
    const request = new Request("https://altin.example/api/portfolio", { method: "GET" });
    await expect(assertRequestIsSafe(request)).resolves.toBeUndefined();
  });
});
