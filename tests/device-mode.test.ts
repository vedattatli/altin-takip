import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveIdleTimeoutMs,
  SHARED_DEVICE_IDLE_TIMEOUT_MS,
  TEST_OVERRIDE_TOKEN,
  type UserProfile,
} from "@/auth/types";
import { sessionCookieOptions } from "@/server/auth/cookies";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";

/**
 * Şirket / ortak cihaz gereksinimleri.
 *
 * Uygulama hiçbir yerel program kurulumu gerektirmez; bütün özellikler normal
 * HTTPS web uygulaması olarak çalışır. Ortak cihazda oturum kalıcı olmaz.
 */

const PASSWORD = "Kuyumcu7Defter";
const EXPIRES = "2026-12-31T00:00:00.000Z";

let backend: LocalAuthBackend;
let service: AuthService;
let user: UserProfile;

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new AuthService(backend);
  user = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe Kullanıcı",
    temporaryPassword: PASSWORD,
    role: "user",
  });
  await backend.setMustChangePassword(user.id, false);
});

describe("oturum çerezi", () => {
  it("her zaman HttpOnly ve SameSite=Lax olur", () => {
    for (const mode of ["personal", "shared"] as const) {
      const options = sessionCookieOptions(EXPIRES, mode, true);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe("lax");
      expect(options.path).toBe("/");
    }
  });

  it("HTTPS üzerinde Secure işaretlenir", () => {
    expect(sessionCookieOptions(EXPIRES, "personal", true).secure).toBe(true);
    expect(sessionCookieOptions(EXPIRES, "shared", true).secure).toBe(true);
  });

  it("ortak cihazda KALICI DEĞİLDİR (son kullanma tarihi yok)", () => {
    const options = sessionCookieOptions(EXPIRES, "shared", true);
    expect("expires" in options).toBe(false);
  });

  it("kişisel cihazda kalıcıdır", () => {
    const options = sessionCookieOptions(EXPIRES, "personal", true);
    expect("expires" in options).toBe(true);
    expect((options as { expires: Date }).expires.toISOString()).toBe(EXPIRES);
  });
});

describe("cihaz modu oturuma yazılır", () => {
  it("varsayılan olarak en kısıtlayıcı mod seçilir", async () => {
    const result = await service.login("ayse", PASSWORD, "127.0.0.1");
    expect(result.deviceMode).toBe("shared");

    const context = await service.resolveSessionContext(result.token);
    expect(context?.deviceMode).toBe("shared");
  });

  it("kişisel cihaz açıkça seçilirse kalıcı oturum verilir", async () => {
    const result = await service.login("ayse", PASSWORD, "127.0.0.1", "personal");
    expect(result.deviceMode).toBe("personal");

    const context = await service.resolveSessionContext(result.token);
    expect(context?.deviceMode).toBe("personal");
    expect(context?.profile.username).toBe("ayse");
  });

  it("aynı kullanıcının farklı cihazlardaki oturumları ayrı modlarda olabilir", async () => {
    const personal = await service.login("ayse", PASSWORD, "10.0.0.1", "personal");
    const shared = await service.login("ayse", PASSWORD, "10.0.0.2", "shared");

    expect((await service.resolveSessionContext(personal.token))?.deviceMode).toBe("personal");
    expect((await service.resolveSessionContext(shared.token))?.deviceMode).toBe("shared");
  });

  it("çıkış yalnızca o cihazın oturumunu kapatır", async () => {
    const personal = await service.login("ayse", PASSWORD, "10.0.0.1", "personal");
    const shared = await service.login("ayse", PASSWORD, "10.0.0.2", "shared");

    await service.logout(shared.token);

    expect(await service.resolveSession(shared.token)).toBeNull();
    expect(await service.resolveSession(personal.token)).not.toBeNull();
  });
});

describe("hareketsizlik süresi", () => {
  it("ortak cihaz için 15 dakikadır", () => {
    expect(SHARED_DEVICE_IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it("test kaçış kapısı kapalıyken kısaltılamaz", () => {
    expect(resolveIdleTimeoutMs({})).toBe(SHARED_DEVICE_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs({ overrideMs: "1000" })).toBe(SHARED_DEVICE_IDLE_TIMEOUT_MS);
    expect(
      resolveIdleTimeoutMs({ allowTestOverrides: "true", overrideMs: "1000" }),
    ).toBe(SHARED_DEVICE_IDLE_TIMEOUT_MS);
  });

  it("yalnızca açık kaçış kapısıyla kısaltılabilir", () => {
    expect(
      resolveIdleTimeoutMs({ allowTestOverrides: TEST_OVERRIDE_TOKEN, overrideMs: "5000" }),
    ).toBe(5000);
  });

  it("geçersiz süre değerleri yok sayılır", () => {
    for (const overrideMs of ["0", "-1", "abc", ""]) {
      expect(
        resolveIdleTimeoutMs({ allowTestOverrides: TEST_OVERRIDE_TOKEN, overrideMs }),
      ).toBe(SHARED_DEVICE_IDLE_TIMEOUT_MS);
    }
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
