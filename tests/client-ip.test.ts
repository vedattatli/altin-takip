import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveClientIp } from "@/server/security/client-ip";

function headersOf(values: Record<string, string>) {
  return new Headers(values);
}

/**
 * Güvenilir vekil politikası: X-Forwarded-For yalnızca bilinen bir ters
 * vekilin arkasında dikkate alınır. Aksi hâlde saldırgan başlıkla kendine
 * yeni IP uydurup hız sınırını atlatamaz.
 */
describe("istemci IP çözümü", () => {
  it("güvenilir vekil yoksa (none) başlıklar YOK SAYILIR", () => {
    const spoofed = headersOf({
      "x-forwarded-for": "203.0.113.77, 10.0.0.1",
      "x-real-ip": "203.0.113.78",
    });
    expect(resolveClientIp(spoofed, "none")).toBe("direct");
    // Her istekte farklı sahte IP verilse de anahtar değişmez.
    expect(resolveClientIp(headersOf({ "x-forwarded-for": "198.51.100.5" }), "none")).toBe(
      "direct",
    );
  });

  it("vercel: x-real-ip önceliklidir, yoksa x-forwarded-for'un ilk elemanı", () => {
    expect(
      resolveClientIp(
        headersOf({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 203.0.113.9" }),
        "vercel",
      ),
    ).toBe("203.0.113.9");
    expect(
      resolveClientIp(headersOf({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), "vercel"),
    ).toBe("198.51.100.1");
    expect(resolveClientIp(headersOf({}), "vercel")).toBe("direct");
  });

  it("local: geliştirme sunucusu için x-forwarded-for kabul edilir", () => {
    expect(resolveClientIp(headersOf({ "x-forwarded-for": "127.0.0.1" }), "local")).toBe(
      "127.0.0.1",
    );
    expect(resolveClientIp(headersOf({}), "local")).toBe("local");
  });

  it("aşırı uzun veya boş değerler yok sayılır", () => {
    expect(resolveClientIp(headersOf({ "x-real-ip": "x".repeat(200) }), "vercel")).toBe("direct");
    expect(resolveClientIp(headersOf({ "x-forwarded-for": "   " }), "local")).toBe("local");
  });
});

describe("TRUSTED_PROXY_PROVIDER yapılandırması", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function providerWith(value: string, nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("TRUSTED_PROXY_PROVIDER", value);
    vi.resetModules();
    const { serverEnv } = await import("@/server/env");
    return serverEnv.trustedProxyProvider;
  }

  it("bilinmeyen sağlayıcı üretimde 'none' olarak yorumlanır (başlıklara güvenilmez)", async () => {
    expect(await providerWith("cloudflare", "production")).toBe("none");
    expect(await providerWith("", "production")).toBe("none");
  });

  it("geçerli değerler aynen kullanılır", async () => {
    expect(await providerWith("vercel", "production")).toBe("vercel");
    expect(await providerWith("none", "production")).toBe("none");
    expect(await providerWith("local", "development")).toBe("local");
  });

  it("geliştirmede boş değer 'local' olur", async () => {
    expect(await providerWith("", "development")).toBe("local");
  });
});
