import { beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_RENEWAL_INTERVAL_MS,
  SESSION_ROLLING_LIFETIME_MS,
  SESSION_ROTATION_GRACE_MS,
  SESSION_ROTATION_INTERVAL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";
import { describeDevice } from "@/server/security/device-label";
import { adminActor } from "./actors";

/**
 * KALICI OTURUM MODELİ — sunucu tarafı.
 *
 * Kullanıcı yalnızca açıkça çıkış yaptığında veya bir güvenlik olayında
 * (parola sıfırlama, pasifleştirme, yönetici iptali, silme) oturumunu
 * kaybeder. Hareketsizlik zaman aşımı YOKTUR; oturum kaydırmalı ömürle
 * sessizce uzar ve kimliği belirli aralıklarla yenilenir.
 */

const PASSWORD = "Kuyumcu7Defter";
const ADMIN_PASSWORD = "Yonetici7Kasa";
const START = Date.parse("2026-03-01T09:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let clock = START;
let backend: LocalAuthBackend;
let service: AuthService;

function advance(ms: number) {
  clock += ms;
}

async function createReady(username: string, role: "admin" | "user" = "user") {
  const user = await backend.createUser({
    username,
    displayName: `${username} Kullanıcı`,
    temporaryPassword: role === "admin" ? ADMIN_PASSWORD : PASSWORD,
    role,
  });
  return backend.setMustChangePassword(user.id, false);
}

beforeEach(async () => {
  clock = START;
  backend = new LocalAuthBackend({ inMemory: true, now: () => clock });
  service = new AuthService(backend, {
    rateLimiter: new MemoryLoginRateLimiter("test-pepper"),
    now: () => clock,
  });
  await createReady("ayse");
});

describe("hareketsizlik oturumu kapatmaz", () => {
  it.each([
    ["15 dakika", 15 * MINUTE],
    ["1 saat", HOUR],
    ["24 saat", DAY],
    ["7 gün", 7 * DAY],
    ["179 gün", 179 * DAY],
  ])("%s hareketsizlikten sonra oturum yaşar", async (_label, idleMs) => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    advance(idleMs);
    expect(await service.resolveSession(token)).not.toBeNull();
  });

  it("tarayıcı kapatılıp açıldığında (aynı çerez) oturum devam eder", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    // Sekme askıya alındı, cihaz yeniden başladı; jeton aynı.
    advance(3 * DAY);
    const context = await service.resolveSessionContext(token);
    expect(context?.profile.username).toBe("ayse");
  });

  it("kaydırmalı ömür hiç kullanılmadan dolarsa oturum sona erer", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    advance(SESSION_ROLLING_LIFETIME_MS + MINUTE);
    expect(await service.resolveSession(token)).toBeNull();
    // Kayıt gerçekten silinmiştir.
    expect(await service.resolveSession(token)).toBeNull();
  });
});

describe("kaydırmalı yenileme (rolling renewal)", () => {
  it("aktif kullanıcı 180 günden uzun süre oturumda kalır", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");

    // Her 30 günde bir tek istek: toplam 2 yıl.
    for (let month = 0; month < 24; month += 1) {
      advance(30 * DAY);
      expect(await service.resolveSession(token), `ay ${month}`).not.toBeNull();
    }
  });

  it("bitiş zamanı aktivitede ileri taşınır", async () => {
    const login = await service.login("ayse", PASSWORD, "127.0.0.1");
    const initialExpiry = Date.parse(login.expiresAt);
    expect(initialExpiry).toBe(START + SESSION_ROLLING_LIFETIME_MS);

    advance(2 * DAY);
    const context = await service.resolveSessionContext(login.token);
    expect(context?.renewed).toBe(true);
    expect(Date.parse(context!.expiresAt)).toBe(clock + SESSION_ROLLING_LIFETIME_MS);
    expect(Date.parse(context!.expiresAt)).toBeGreaterThan(initialExpiry);
  });

  it("her API çağrısında veritabanına YAZILMAZ", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");

    let touches = 0;
    const original = backend.touchSession.bind(backend);
    backend.touchSession = async (...args) => {
      touches += 1;
      return original(...args);
    };

    // Aynı dakika içinde 10 istek: hiçbir yazma yok.
    for (let index = 0; index < 10; index += 1) {
      const context = await service.resolveSessionContext(token);
      expect(context?.renewed).toBe(false);
    }
    expect(touches).toBe(0);

    // last_seen eşiği geçince tek yazma; bitiş zamanı henüz uzatılmaz.
    advance(SESSION_TOUCH_INTERVAL_MS + 1000);
    const touched = await service.resolveSessionContext(token);
    expect(touches).toBe(1);
    expect(touched?.renewed).toBe(false);

    // 24 saat eşiği geçince süre uzatılır; yine tek yazma.
    advance(SESSION_RENEWAL_INTERVAL_MS + 1000);
    const renewed = await service.resolveSessionContext(token);
    expect(touches).toBe(2);
    expect(renewed?.renewed).toBe(true);

    backend.touchSession = original;
  });

  it("süre uzatma en fazla 24 saatte bir yapılır", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    const first = (await service.resolveSessionContext(token))!;

    advance(6 * HOUR);
    const later = (await service.resolveSessionContext(token))!;
    expect(later.expiresAt).toBe(first.expiresAt);

    advance(19 * HOUR);
    const renewed = (await service.resolveSessionContext(token))!;
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
  });
});

describe("oturum kimliği yenileme (rotation)", () => {
  it("yenileme zamanı gelmeden kimlik değişmez", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    advance(SESSION_ROTATION_INTERVAL_MS - HOUR);
    const context = (await service.resolveSessionContext(token))!;
    expect(await service.rotateSessionIfDue(context)).toBeNull();
  });

  it("zamanı gelince yeni kimlik verilir; eski kimlik kısa süre sonra geçersizdir", async () => {
    const { token: oldToken } = await service.login("ayse", PASSWORD, "127.0.0.1");
    advance(SESSION_ROTATION_INTERVAL_MS + MINUTE);

    const context = (await service.resolveSessionContext(oldToken))!;
    const newToken = await service.rotateSessionIfDue(context);
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    // Yeni kimlik aynı oturumu çözer; kullanıcı fark etmez.
    const rotated = await service.resolveSessionContext(newToken);
    expect(rotated?.sessionId).toBe(context.sessionId);

    // Uçuştaki istekler için eski kimlik tolerans süresinde kabul edilir...
    advance(SESSION_ROTATION_GRACE_MS - 1000);
    expect(await service.resolveSession(oldToken)).not.toBeNull();

    // ...sonra reddedilir. Sonsuza dek geçerli jeton yoktur.
    advance(2000);
    expect(await service.resolveSession(oldToken)).toBeNull();
    expect(await service.resolveSession(newToken)).not.toBeNull();
  });

  it("yenilenen kimlik bir daha yenilenmez (aralık sıfırlanır)", async () => {
    const { token } = await service.login("ayse", PASSWORD, "127.0.0.1");
    advance(SESSION_ROTATION_INTERVAL_MS + MINUTE);
    const context = (await service.resolveSessionContext(token))!;
    const newToken = (await service.rotateSessionIfDue(context))!;

    const fresh = (await service.resolveSessionContext(newToken))!;
    expect(await service.rotateSessionIfDue(fresh)).toBeNull();
  });
});

describe("çıkış davranışı", () => {
  it("normal çıkış yalnızca bu cihazın oturumunu kapatır", async () => {
    const phone = await service.login("ayse", PASSWORD, "10.0.0.1", "Safari · iOS");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2", "Chrome · Windows");

    await service.logout(phone.token);

    expect(await service.resolveSession(phone.token)).toBeNull();
    expect(await service.resolveSession(laptop.token)).not.toBeNull();
  });

  it("tüm cihazlardan çıkış bütün oturumları kapatır", async () => {
    const phone = await service.login("ayse", PASSWORD, "10.0.0.1");
    const tablet = await service.login("ayse", PASSWORD, "10.0.0.2");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.3");

    const actor = await service.requireAuthenticatedUser(laptop.token);
    expect(await service.logoutEverywhere(actor)).toBe(3);

    for (const session of [phone, tablet, laptop]) {
      expect(await service.resolveSession(session.token)).toBeNull();
    }
  });

  it("kullanıcı kendi oturumlarını güvenli metadata ile listeler", async () => {
    const phone = await service.login("ayse", PASSWORD, "10.0.0.1", "Safari · iOS");
    advance(MINUTE);
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2", "Chrome · Windows");

    const actor = await service.requireAuthenticatedUser(laptop.token);
    const sessions = await service.listOwnSessions(actor);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.current).toBe(true);
    expect(sessions[0]!.deviceLabel).toBe("Chrome · Windows");
    expect(sessions[1]!.current).toBe(false);
    // Ham IP veya jeton içermez.
    const serialized = JSON.stringify(sessions);
    expect(serialized).not.toContain("10.0.0.");
    expect(serialized).not.toContain(phone.token);
    expect(serialized).not.toContain(laptop.token);
    expect(Object.keys(sessions[0]!).sort()).toEqual(
      ["createdAt", "current", "deviceLabel", "expiresAt", "id", "lastSeenAt"].sort(),
    );
  });
});

describe("oturumu zorunlu sonlandıran güvenlik olayları", () => {
  it("kullanıcının kendi parola değişikliği diğer cihazları kapatır, bu cihazı korur", async () => {
    const phone = await service.login("ayse", PASSWORD, "10.0.0.1");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2");

    const actor = await service.requireAuthenticatedUser(laptop.token);
    await service.changeOwnPassword(actor, PASSWORD, "YepyeniParola7Kasa");

    expect(await service.resolveSession(laptop.token)).not.toBeNull();
    expect(await service.resolveSession(phone.token)).toBeNull();
  });

  it("yönetici parola sıfırlaması bütün cihazları kapatır", async () => {
    const adminProfile = await createReady("yonetici", "admin");
    const admin = new AdminService(backend);
    const user = (await backend.findProfileByUsername("ayse"))!;

    const phone = await service.login("ayse", PASSWORD, "10.0.0.1");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2");

    await admin.resetUserPassword(adminActor(adminProfile), user.id, "GeciciParola7Kasa");

    expect(await service.resolveSession(phone.token)).toBeNull();
    expect(await service.resolveSession(laptop.token)).toBeNull();
  });

  it("pasifleştirme bütün cihazları anında kapatır", async () => {
    const adminProfile = await createReady("yonetici", "admin");
    const admin = new AdminService(backend);
    const user = (await backend.findProfileByUsername("ayse"))!;

    const phone = await service.login("ayse", PASSWORD, "10.0.0.1");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2");

    await admin.setUserStatus(adminActor(adminProfile), user.id, "inactive");

    expect(await service.resolveSession(phone.token)).toBeNull();
    expect(await service.resolveSession(laptop.token)).toBeNull();
    // Yeniden aktifleştirilse bile eski oturumlar geri gelmez.
    await admin.setUserStatus(adminActor(adminProfile), user.id, "active");
    expect(await service.resolveSession(laptop.token)).toBeNull();
  });

  it("yönetici belirli bir oturumu veya bütün oturumları iptal edebilir", async () => {
    const adminProfile = await createReady("yonetici", "admin");
    const admin = new AdminService(backend, { now: () => clock });
    const user = (await backend.findProfileByUsername("ayse"))!;

    const phone = await service.login("ayse", PASSWORD, "10.0.0.1", "Safari · iOS");
    const laptop = await service.login("ayse", PASSWORD, "10.0.0.2", "Chrome · Windows");

    const listed = await admin.listUserSessions(adminActor(adminProfile), user.id);
    expect(listed).toHaveLength(2);
    expect(listed.every((session) => session.current === false)).toBe(true);

    const phoneSession = listed.find((session) => session.deviceLabel === "Safari · iOS")!;
    await admin.revokeUserSession(adminActor(adminProfile), user.id, phoneSession.id);
    expect(await service.resolveSession(phone.token)).toBeNull();
    expect(await service.resolveSession(laptop.token)).not.toBeNull();

    const result = await admin.revokeUserSessions(adminActor(adminProfile), user.id);
    expect(result.closedSessions).toBe(1);
    expect(await service.resolveSession(laptop.token)).toBeNull();
  });

  it("yönetici başka kullanıcının oturumunu kullanıcı kimliği uyuşmadan kapatamaz", async () => {
    const adminProfile = await createReady("yonetici", "admin");
    const admin = new AdminService(backend, { now: () => clock });
    const ayse = (await backend.findProfileByUsername("ayse"))!;
    await createReady("mehmet");
    const mehmet = (await backend.findProfileByUsername("mehmet"))!;

    const session = await service.login("ayse", PASSWORD, "10.0.0.1");
    const [listed] = await admin.listUserSessions(adminActor(adminProfile), ayse.id);

    // Oturum Ayşe'nin; Mehmet'in kimliğiyle kapatılamaz.
    await expect(
      admin.revokeUserSession(adminActor(adminProfile), mehmet.id, listed!.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.resolveSession(session.token)).not.toBeNull();
  });

  it("hesap silinince bütün oturumlar kapanır", async () => {
    const adminProfile = await createReady("yonetici", "admin");
    const admin = new AdminService(backend);
    const user = (await backend.findProfileByUsername("ayse"))!;
    const session = await service.login("ayse", PASSWORD, "10.0.0.1");

    await admin.deleteUser(adminActor(adminProfile), user.id, "ayse");
    expect(await service.resolveSession(session.token)).toBeNull();
  });

  it("silinmiş / iptal edilmiş oturum kimliği reddedilir", async () => {
    const session = await service.login("ayse", PASSWORD, "10.0.0.1");
    const context = (await service.resolveSessionContext(session.token))!;
    const user = (await backend.findProfileByUsername("ayse"))!;

    expect(await backend.destroySessionById(user.id, context.sessionId)).toBe(true);
    expect(await service.resolveSession(session.token)).toBeNull();
    await expect(service.requireAuthenticatedUser(session.token)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("temizlik", () => {
  it("purgeExpiredSessions yalnızca süresi dolanları siler", async () => {
    const stale = await service.login("ayse", PASSWORD, "10.0.0.1");
    advance(SESSION_ROLLING_LIFETIME_MS - DAY);
    const fresh = await service.login("ayse", PASSWORD, "10.0.0.2");
    advance(2 * DAY);

    expect(await service.purgeExpiredSessions()).toBe(1);
    expect(await service.resolveSession(stale.token)).toBeNull();
    expect(await service.resolveSession(fresh.token)).not.toBeNull();
  });
});

describe("cihaz etiketi", () => {
  it("ham User-Agent yerine kaba, kullanıcı dostu tanım üretir", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      ),
    ).toBe("Chrome · Windows");
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iOS");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14) Firefox/128.0")).toBe(
      "Firefox · Android",
    );
    expect(describeDevice(null)).toBe("Bilinmeyen cihaz");
  });

  it("giriş yanıtı cihaz türü veya oturum kimliği dışında bir şey içermez", async () => {
    const result = await service.login("ayse", PASSWORD, "10.0.0.1", "Chrome · Windows");
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "token", "user"]);
  });
});
