import { beforeEach, describe, expect, it } from "vitest";

import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";
import {
  DEFAULT_LOGIN_RATE_LIMIT_POLICY,
  loginRateLimitBuckets,
  type LoginRateLimitPolicy,
  type RateLimitSettings,
} from "@/server/rate-limit/types";

/**
 * ÜÇLÜ SAYAÇ MODELİ
 *
 * Yalnız IP, yalnız kullanıcı adı ve IP+kullanıcı adı için ayrı sayaçlar
 * tutulur. Herhangi biri kilitliyse giriş reddedilir. Başarılı girişte
 * yalnızca kombinasyon sayacı sıfırlanır.
 */

const PASSWORD = "Kuyumcu7Defter";
const base: RateLimitSettings = {
  maxAttempts: 2,
  windowMs: 60_000,
  baseLockMs: 30_000,
  maxLockMs: 120_000,
};

// Test politikası: kombinasyon 2, kullanıcı adı 3, IP 4 deneme.
const POLICY: LoginRateLimitPolicy = {
  pair: base,
  username: { ...base, maxAttempts: 3 },
  ip: { ...base, maxAttempts: 4 },
};

let backend: LocalAuthBackend;
let service: AuthService;

async function fail(username: string, ip: string) {
  await service.login(username, "YanlisParola1", ip).catch(() => undefined);
}

async function expectLocked(username: string, ip: string) {
  await expect(service.login(username, PASSWORD, ip)).rejects.toMatchObject({ status: 429 });
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new AuthService(backend, {
    rateLimiter: new MemoryLoginRateLimiter("test-pepper"),
    loginRateLimits: POLICY,
  });
  for (const username of ["ayse", "mehmet", "zeynep", "ali", "fatma", "can"]) {
    const user = await backend.createUser({
      username,
      displayName: `${username} Kullanıcı`,
      temporaryPassword: PASSWORD,
      role: "user",
    });
    await backend.setMustChangePassword(user.id, false);
  }
});

describe("sayaç anahtarları", () => {
  it("üç ayrı anahtar üretir ve sıra ip, username, pair'dir", () => {
    const buckets = loginRateLimitBuckets("203.0.113.9", "ayse");
    expect(buckets.map((bucket) => bucket.kind)).toEqual(["ip", "username", "pair"]);
    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "ip:203.0.113.9",
      "user:ayse",
      "pair:203.0.113.9|ayse",
    ]);
    expect(buckets[2]!.settings).toBe(DEFAULT_LOGIN_RATE_LIMIT_POLICY.pair);
  });

  it("boş kullanıcı adı için de anahtar üretir", () => {
    expect(loginRateLimitBuckets("1.2.3.4", "")[1]!.key).toBe("user:?");
  });

  it("varsayılan politika: kombinasyon en sıkı, IP en geniş eşiktir", () => {
    const { ip, username, pair } = DEFAULT_LOGIN_RATE_LIMIT_POLICY;
    expect(pair.maxAttempts).toBeLessThan(username.maxAttempts);
    expect(username.maxAttempts).toBeLessThan(ip.maxAttempts);
  });
});

describe("credential stuffing: aynı IP, farklı kullanıcı adları", () => {
  it("IP sayacı dolunca o IP'den hiçbir kullanıcı giriş yapamaz", async () => {
    const ip = "203.0.113.9";
    for (const username of ["ayse", "mehmet", "zeynep", "ali"]) await fail(username, ip);

    // Kombinasyon ve kullanıcı adı sayaçları dolmadı; yalnız IP sayacı doldu.
    await expectLocked("fatma", ip);
    // Doğru parola bile kabul edilmez.
    await expectLocked("can", ip);
    // Başka IP'den aynı kullanıcı giriş yapabilir.
    await expect(service.login("can", PASSWORD, "198.51.100.1")).resolves.toBeTruthy();
  });
});

describe("dağıtık deneme: aynı kullanıcı adı, farklı IP'ler", () => {
  it("kullanıcı adı sayacı dolunca hangi IP'den gelirse gelsin reddedilir", async () => {
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) await fail("ayse", ip);

    await expectLocked("ayse", "10.0.0.4");
    // Başka kullanıcı etkilenmez.
    await expect(service.login("mehmet", PASSWORD, "10.0.0.4")).resolves.toBeTruthy();
  });
});

describe("kombinasyon sayacı ve başarılı girişte sıfırlama", () => {
  it("aynı IP+kullanıcı için kombinasyon sayacı en erken kilitlenir", async () => {
    await fail("ayse", "10.0.0.1");
    await fail("ayse", "10.0.0.1");
    await expectLocked("ayse", "10.0.0.1");
    // Aynı kullanıcı başka IP'den: kullanıcı adı sayacı (3) henüz dolmadı.
    await expect(service.login("ayse", PASSWORD, "10.0.0.2")).resolves.toBeTruthy();
  });

  it("başarılı giriş yalnızca kombinasyon sayacını sıfırlar; IP sayacı korunur", async () => {
    const ip = "10.0.0.1";
    // IP sayacı: 2 başarısız (farklı kullanıcılar) + 1 ayse = 3/4.
    for (const username of ["mehmet", "zeynep"]) await fail(username, ip);
    await fail("ayse", ip);

    // Kombinasyon 1/2 -> başarılı giriş yalnızca kombinasyonu sıfırlar.
    await expect(service.login("ayse", PASSWORD, ip)).resolves.toBeTruthy();

    // IP sayacı 3'te kaldı: bir başarısızlık daha 4'e tamamlar ve IP kilitlenir.
    await fail("ali", ip);
    await expectLocked("fatma", ip);
    // IP sıfırlanmış olsaydı bu deneme geçerdi.
  });

  it("başarılı giriş kombinasyon sayacını gerçekten sıfırlar", async () => {
    await fail("ayse", "10.0.0.9");
    await expect(service.login("ayse", PASSWORD, "10.0.0.9")).resolves.toBeTruthy();

    // Sıfırlandığı için tek başarısızlık kilitlemez.
    await fail("ayse", "10.0.0.9");
    await expect(service.login("ayse", PASSWORD, "10.0.0.9")).resolves.toBeTruthy();
  });

  it("kilitli yanıt Retry-After bilgisi taşır", async () => {
    await fail("ayse", "10.0.0.1");
    await fail("ayse", "10.0.0.1");
    await expect(service.login("ayse", PASSWORD, "10.0.0.1")).rejects.toMatchObject({
      status: 429,
      retryAfterMs: expect.any(Number),
    });
  });
});
