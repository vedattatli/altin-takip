import { beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
  BROWSER_SESSION_ABSOLUTE_MS,
  BROWSER_SESSION_IDLE_MS,
  NON_PERSISTENT_TOUCH_INTERVAL_MS,
  SESSION_ROLLING_LIFETIME_MS,
} from "@/auth/types";
import { sessionCookieOptions } from "@/server/auth/cookies";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService, sessionPolicyFor } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";

/**
 * OTURUM POLİTİKASI — "Bu cihazda oturumumu açık tut"
 *
 *  A. işaretli   : kalıcı çerez, 180 gün kaydırmalı (persistent-session.test.ts)
 *  B. işaretsiz  : tarayıcı oturumu çerezi, 8 saat mutlak, 30 dk hareketsizlik
 *  C. admin      : tercihten bağımsız 8 saat mutlak, 15 dk hareketsizlik, asla kalıcı değil
 */

const PASSWORD = "Kuyumcu7Defter";
const ADMIN_PASSWORD = "Yonetici7Kasa";
const START = Date.parse("2026-03-01T09:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let clock = START;
let backend: LocalAuthBackend;
let service: AuthService;

function advance(ms: number) {
  clock += ms;
}

beforeEach(async () => {
  clock = START;
  backend = new LocalAuthBackend({ inMemory: true, now: () => clock });
  service = new AuthService(backend, { rateLimiter: new MemoryLoginRateLimiter("test-pepper"), now: () => clock });
  for (const [username, role, password] of [
    ["ayse", "user", PASSWORD],
    ["yonetici", "admin", ADMIN_PASSWORD],
  ] as const) {
    const user = await backend.createUser({ username, displayName: username, temporaryPassword: password, role });
    await backend.setMustChangePassword(user.id, false);
  }
});

describe("politika matrisi", () => {
  it("kullanıcı + işaretli: kalıcı, hareketsizlik yok, 180 gün", () => {
    expect(sessionPolicyFor("user", true)).toEqual({
      persistent: true,
      idleTimeoutMs: null,
      absoluteLifetimeMs: SESSION_ROLLING_LIFETIME_MS,
    });
  });

  it("kullanıcı + işaretsiz: tarayıcı oturumu, 30 dk hareketsizlik, 8 saat mutlak", () => {
    expect(sessionPolicyFor("user", false)).toEqual({
      persistent: false,
      idleTimeoutMs: BROWSER_SESSION_IDLE_MS,
      absoluteLifetimeMs: BROWSER_SESSION_ABSOLUTE_MS,
    });
    expect(BROWSER_SESSION_IDLE_MS).toBeLessThanOrEqual(30 * MINUTE);
    expect(BROWSER_SESSION_ABSOLUTE_MS).toBeLessThanOrEqual(8 * HOUR);
  });

  it("admin: tercihten bağımsız 15 dk hareketsizlik, 8 saat mutlak, asla kalıcı değil", () => {
    for (const keep of [true, false]) {
      expect(sessionPolicyFor("admin", keep)).toEqual({
        persistent: false,
        idleTimeoutMs: ADMIN_SESSION_IDLE_MS,
        absoluteLifetimeMs: ADMIN_SESSION_ABSOLUTE_MS,
      });
    }
    expect(ADMIN_SESSION_IDLE_MS).toBeLessThanOrEqual(15 * MINUTE);
    expect(ADMIN_SESSION_ABSOLUTE_MS).toBeLessThanOrEqual(8 * HOUR);
  });
});

describe("çerez", () => {
  const EXPIRES = "2026-12-31T00:00:00.000Z";

  it("işaretsiz: son kullanma tarihi verilmez (tarayıcı kapanınca silinir)", () => {
    const options = sessionCookieOptions(EXPIRES, true, false);
    expect("expires" in options).toBe(false);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect("domain" in options).toBe(false);
  });

  it("işaretli: son kullanma tarihi sunucudaki bitiştir", () => {
    const options = sessionCookieOptions(EXPIRES, true, true) as { expires?: Date };
    expect(options.expires?.toISOString()).toBe(EXPIRES);
  });
});

describe("tarayıcı oturumu (işaretsiz)", () => {
  it("giriş kalıcı olmayan oturum döner", async () => {
    const result = await service.login("ayse", PASSWORD, "127.0.0.1", "Chrome · Windows", false);
    expect(result.persistent).toBe(false);
    expect(Date.parse(result.expiresAt)).toBe(START + BROWSER_SESSION_ABSOLUTE_MS);
    const context = await service.resolveSessionContext(result.token);
    expect(context?.persistent).toBe(false);
    expect(context?.idleExpiresAt).not.toBeNull();
  });

  it("varsayılan (parametre verilmezse) tarayıcı oturumudur", async () => {
    const result = await service.login("ayse", PASSWORD, "127.0.0.1");
    expect(result.persistent).toBe(false);
  });

  it("30 dakika hareketsizlikte oturum düşer; 29 dakikada yaşar", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "Cihaz", false);
    advance(29 * MINUTE);
    expect(await service.resolveSession(token)).not.toBeNull();
    advance(2 * MINUTE);
    expect(await service.resolveSession(token)).not.toBeNull(); // 29. dakikadaki istek pencereyi ileri aldı
    advance(31 * MINUTE);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("sürekli hareket olsa bile 8 saatte sona erer", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "Cihaz", false);
    let elapsed = 0;
    let alive = true;
    while (elapsed < BROWSER_SESSION_ABSOLUTE_MS + 20 * MINUTE && alive) {
      advance(10 * MINUTE);
      elapsed += 10 * MINUTE;
      alive = (await service.resolveSession(token)) !== null;
    }
    expect(alive).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(BROWSER_SESSION_ABSOLUTE_MS);
  });

  it("hareketsizlik penceresi her istekte değil, en fazla 60 sn'de bir yazılır", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1", "Cihaz", false);
    let touches = 0;
    const original = backend.touchSession.bind(backend);
    backend.touchSession = async (...args) => {
      touches += 1;
      return original(...args);
    };
    for (let index = 0; index < 5; index += 1) await service.resolveSession(token);
    expect(touches).toBe(0);
    advance(NON_PERSISTENT_TOUCH_INTERVAL_MS + 1000);
    await service.resolveSession(token);
    expect(touches).toBe(1);
    backend.touchSession = original;
  });

  it("kalıcı olmayan oturum kimliği yenilenmez (kısa ömürlü) ve süresi uzatılmaz", async () => {
    const { token, expiresAt } = await service.login("ayse", PASSWORD, "127.0.0.1", "Cihaz", false);
    // 2 saat boyunca 20 dakikada bir istek: hareketsizlik dolmaz, mutlak bitiş DEĞİŞMEZ.
    for (let round = 0; round < 6; round += 1) {
      advance(20 * MINUTE);
      expect(await service.resolveSession(token), `tur ${round}`).not.toBeNull();
    }
    const context = (await service.resolveSessionContext(token))!;
    expect(context.expiresAt).toBe(expiresAt);
    expect(context.renewed).toBe(false);
    expect(await service.rotateSessionIfDue(context)).toBeNull();
  });

  it("süresi dolan kayıtlar bakım temizliğiyle silinir", async () => {
    const browser = await service.login("ayse", PASSWORD, "10.0.0.1", "Cihaz", false);
    const persistent = await service.login("ayse", PASSWORD, "10.0.0.2", "Cihaz", true);
    advance(31 * MINUTE);
    expect(await service.purgeExpiredSessions()).toBe(1);
    expect(await service.resolveSession(browser.token)).toBeNull();
    expect(await service.resolveSession(persistent.token)).not.toBeNull();
  });
});

describe("admin oturumu", () => {
  it("işaretli olsa bile kalıcı değildir; çerez tarayıcı oturumu çerezidir", async () => {
    const result = await service.login("yonetici", ADMIN_PASSWORD, "127.0.0.1", "Cihaz", true);
    expect(result.persistent).toBe(false);
    expect(Date.parse(result.expiresAt)).toBe(START + ADMIN_SESSION_ABSOLUTE_MS);
    expect("expires" in sessionCookieOptions(result.expiresAt, true, result.persistent)).toBe(false);
  });

  it("15 dakika hareketsizlikte düşer", async () => {
    const { token } = await service.login("yonetici", ADMIN_PASSWORD, "127.0.0.1", "Cihaz", true);
    advance(14 * MINUTE);
    expect(await service.resolveSession(token)).not.toBeNull();
    advance(16 * MINUTE);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("aktif olsa bile 8 saatte sona erer", async () => {
    const { token } = await service.login("yonetici", ADMIN_PASSWORD, "127.0.0.1", "Cihaz", true);
    for (let round = 0; round < 47; round += 1) {
      advance(10 * MINUTE);
      expect(await service.resolveSession(token), `tur ${round}`).not.toBeNull();
    }
    advance(20 * MINUTE);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("kalıcı işaretli eski bir admin oturumu çözümlemede reddedilir", async () => {
    const admin = (await backend.findProfileByUsername("yonetici"))!;
    const record = await backend.createSession(admin.id, clock, "Eski", {
      persistent: true,
      idleTimeoutMs: null,
      absoluteLifetimeMs: SESSION_ROLLING_LIFETIME_MS,
    });
    expect(await service.resolveSession(record.token)).toBeNull();
  });
});

describe("kalıcı oturum (işaretli) değişmedi", () => {
  it("180 gün kaydırmalı ömür ve hareketsizlik yok", async () => {
    const result = await service.login("ayse", PASSWORD, "127.0.0.1", "Cihaz", true);
    expect(result.persistent).toBe(true);
    expect(Date.parse(result.expiresAt)).toBe(START + SESSION_ROLLING_LIFETIME_MS);
    advance(3 * 24 * HOUR);
    expect(await service.resolveSession(result.token)).not.toBeNull();
  });

  it("aynı kullanıcı bir cihazda kalıcı, diğerinde tarayıcı oturumu açabilir", async () => {
    const phone = await service.login("ayse", PASSWORD, "10.0.0.1", "Safari · iOS", true);
    const kiosk = await service.login("ayse", PASSWORD, "10.0.0.2", "Chrome · Windows", false);
    const actor = await service.requireAuthenticatedUser(phone.token);
    const sessions = await service.listOwnSessions(actor);
    expect(sessions.map((session) => session.persistent).sort()).toEqual([false, true]);
    expect(sessions.find((session) => session.current)?.persistent).toBe(true);
    expect(kiosk.persistent).toBe(false);
  });
});
