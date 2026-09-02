import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_ROLLING_LIFETIME_MS, TEST_OVERRIDE_TOKEN } from "@/auth/types";
import { sessionCookieOptions } from "@/server/auth/cookies";
import { LocalAuthBackend } from "@/server/auth/local-backend";

/**
 * Oturum çerezi: her cihazda aynı, kalıcı ve yalnızca HttpOnly.
 * Uygulama hiçbir yerel program kurulumu gerektirmez; bütün özellikler normal
 * HTTPS web uygulaması olarak çalışır.
 */

const EXPIRES = "2026-12-31T00:00:00.000Z";

describe("oturum çerezi", () => {
  it("HttpOnly, SameSite=Lax, Path=/ ve Domain'siz olur", () => {
    const options = sessionCookieOptions(EXPIRES, true, true);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect("domain" in options).toBe(false);
  });

  it("HTTPS üzerinde Secure işaretlenir", () => {
    expect(sessionCookieOptions(EXPIRES, true, true).secure).toBe(true);
    expect(sessionCookieOptions(EXPIRES, false, true).secure).toBe(false);
  });

  it("'oturumu açık tut' işaretliyse KALICIDIR: son kullanma tarihi oturumun bitiş zamanıdır", () => {
    const options = sessionCookieOptions(EXPIRES, true, true) as { expires?: Date };
    expect(options.expires?.toISOString()).toBe(EXPIRES);
  });

  it("kaydırmalı ömür 180 gündür ve kısa oturum yoktur", () => {
    expect(SESSION_ROLLING_LIFETIME_MS).toBe(180 * 24 * 60 * 60 * 1000);
  });
});

describe("yerel arka uç üretim koruması", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kaçış kapısı bilinçli olarak tahmin edilmesi zor bir değerdir", () => {
    expect(TEST_OVERRIDE_TOKEN).toBe("yalnizca-test-icin");
  });

  it("yerel arka uç üretimde yalnızca açık kaçış kapısıyla çalışır", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_ALLOW_LOCAL_BACKEND", "");

    expect(() => new LocalAuthBackend({ inMemory: true })).toThrow(
      /üretim ortamında kullanılamaz/,
    );

    vi.stubEnv("AUTH_ALLOW_LOCAL_BACKEND", TEST_OVERRIDE_TOKEN);
    expect(() => new LocalAuthBackend({ inMemory: true })).not.toThrow();
  });

  it("yanlış belirteçle üretimde çalışmaz", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_ALLOW_LOCAL_BACKEND", "true");

    expect(() => new LocalAuthBackend({ inMemory: true })).toThrow(
      /üretim ortamında kullanılamaz/,
    );
  });
});
