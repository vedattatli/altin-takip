import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { AppError } from "@/server/auth/errors";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";
import { userActor } from "./actors";

const ADMIN_PASSWORD = "Yonetici7Kasa";
const USER_PASSWORD = "Kuyumcu7Defter";
const CLIENT = "127.0.0.1";

let backend: LocalAuthBackend;
let service: AuthService;
let admin: UserProfile;

async function createReadyUser(username: string, password = USER_PASSWORD) {
  const user = await backend.createUser({
    username,
    displayName: `${username} Kullanıcı`,
    temporaryPassword: password,
    role: "user",
  });
  return backend.setMustChangePassword(user.id, false);
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new AuthService(backend, {
    rateLimiter: new MemoryLoginRateLimiter("test-pepper", {
      maxAttempts: 3,
      windowMs: 60_000,
      baseLockMs: 30_000,
      maxLockMs: 120_000,
    }),
  });

  // İlk yönetici yalnızca sunucu tarafında (bootstrap CLI'ın yaptığı gibi) oluşturulur.
  admin = await backend.createUser({
    username: "yonetici",
    displayName: "Sistem Yöneticisi",
    temporaryPassword: ADMIN_PASSWORD,
    role: "admin",
  });
  admin = await backend.setMustChangePassword(admin.id, false);
});

describe("giriş", () => {
  it("doğru bilgilerle oturum açar", async () => {
    const result = await service.login("yonetici", ADMIN_PASSWORD, CLIENT);

    expect(result.token).toBeTruthy();
    expect(result.user.username).toBe("yonetici");
    expect(result.user.role).toBe("admin");
    // Oturum bilgisinde dahili e-posta veya parola alanı BULUNMAZ.
    expect(Object.keys(result.user).sort()).toEqual(
      ["displayName", "id", "mustChangePassword", "role", "username"].sort(),
    );
  });

  it("kullanıcı adını normalize eder (büyük/küçük harf duyarsız)", async () => {
    const result = await service.login("YÖNETİCİ", ADMIN_PASSWORD, CLIENT);
    expect(result.user.username).toBe("yonetici");
  });

  it("son giriş zamanını kaydeder", async () => {
    await service.login("yonetici", ADMIN_PASSWORD, CLIENT);
    const profile = await backend.getProfile(admin.id);
    expect(profile?.lastLoginAt).toBeTruthy();
  });

  it("yanlış parolada genel hata verir", async () => {
    await expect(service.login("yonetici", "YanlisParola1", CLIENT)).rejects.toMatchObject({
      status: 401,
      message: "Kullanıcı adı veya parola hatalı.",
    });
  });

  it("olmayan kullanıcı ile yanlış parola AYNI mesajı verir", async () => {
    const unknown = await service
      .login("olmayankullanici", "Herhangi7Parola", CLIENT)
      .catch((error: AppError) => error.message);
    const wrong = await service
      .login("yonetici", "YanlisParola1", "10.0.0.1")
      .catch((error: AppError) => error.message);

    expect(unknown).toBe(wrong);
    expect(unknown).toBe("Kullanıcı adı veya parola hatalı.");
  });

  it("pasif kullanıcı giriş yapamaz ve ayrı bir ipucu verilmez", async () => {
    const user = await createReadyUser("ayse");
    await backend.setStatus(user.id, "inactive");

    await expect(service.login("ayse", USER_PASSWORD, CLIENT)).rejects.toMatchObject({
      message: "Kullanıcı adı veya parola hatalı.",
    });
  });

  it("tekrarlanan başarısız denemede geçici bekleme uygular", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await service.login("yonetici", "YanlisParola1", CLIENT).catch(() => undefined);
    }

    await expect(service.login("yonetici", "YanlisParola1", CLIENT)).rejects.toMatchObject({
      status: 429,
    });
    // Doğru parola bile bekleme süresi dolmadan kabul edilmez.
    await expect(service.login("yonetici", ADMIN_PASSWORD, CLIENT)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("hız sınırı istemci ve kullanıcı bazlıdır", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.login("yonetici", "YanlisParola1", CLIENT).catch(() => undefined);
    }
    const result = await service.login("yonetici", ADMIN_PASSWORD, "203.0.113.9");
    expect(result.user.username).toBe("yonetici");
  });

  it("boş kullanıcı adı veya parola reddedilir", async () => {
    await expect(service.login("", "", CLIENT)).rejects.toBeInstanceOf(AppError);
  });
});

describe("oturum", () => {
  it("çerez jetonundan profili çözer", async () => {
    const { token } = await service.login("yonetici", ADMIN_PASSWORD, CLIENT);
    const session = await service.resolveSessionContext(token);
    expect(session?.profile.id).toBe(admin.id);
    expect(session?.sessionId).toBeTruthy();
  });

  it("çıkış yapınca oturum geçersiz olur", async () => {
    const { token } = await service.login("yonetici", ADMIN_PASSWORD, CLIENT);
    await service.logout(token);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("pasifleştirme mevcut oturumu anında düşürür", async () => {
    const user = await createReadyUser("ayse");
    const { token } = await service.login("ayse", USER_PASSWORD, CLIENT);
    expect(await service.resolveSession(token)).not.toBeNull();

    await backend.setStatus(user.id, "inactive");
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("geçersiz jeton için oturum yoktur", async () => {
    expect(await service.resolveSession("uydurma-jeton")).toBeNull();
    expect(await service.resolveSession(null)).toBeNull();
  });

  it("requireAdmin normal kullanıcıyı reddeder", async () => {
    await createReadyUser("ayse");
    const { token } = await service.login("ayse", USER_PASSWORD, CLIENT);

    await expect(service.requireAdmin(token)).rejects.toMatchObject({ status: 403 });
    await expect(service.requireUsableUser(token)).resolves.toMatchObject({
      profile: { username: "ayse" },
    });
  });
});

describe("geçici parola sunucu koruması", () => {
  let pendingToken: string;

  beforeEach(async () => {
    await backend.createUser({
      username: "gecici",
      displayName: "Geçici Parolalı",
      temporaryPassword: USER_PASSWORD,
      role: "user",
    });
    const result = await service.login("gecici", USER_PASSWORD, CLIENT);
    pendingToken = result.token;
    expect(result.user.mustChangePassword).toBe(true);
  });

  it("requireAuthenticatedUser geçer (oturum/çıkış/parola değiştirme için)", async () => {
    const actor = await service.requireAuthenticatedUser(pendingToken);
    expect(actor.profile.username).toBe("gecici");
  });

  it("requireUsableUser PASSWORD_CHANGE_REQUIRED ile reddeder", async () => {
    await expect(service.requireUsableUser(pendingToken)).rejects.toMatchObject({
      status: 403,
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  });

  it("requireAdmin de reddeder (geçici parolalı yönetici olsa bile)", async () => {
    await backend.createUser({
      username: "gecicadmin",
      displayName: "Geçici Yönetici",
      temporaryPassword: ADMIN_PASSWORD,
      role: "admin",
    });
    const { token } = await service.login("gecicadmin", ADMIN_PASSWORD, "10.1.1.1");

    await expect(service.requireAdmin(token)).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  });

  it("parola değiştirildikten sonra korumalı uçlar açılır", async () => {
    const actor = await service.requireAuthenticatedUser(pendingToken);
    await service.changeOwnPassword(actor, USER_PASSWORD, "YeniParola7Kasa");

    // Tüm oturumlar düştüğü için yeniden giriş gerekir.
    expect(await service.resolveSession(pendingToken)).toBeNull();

    const next = await service.login("gecici", "YeniParola7Kasa", "10.2.2.2");
    expect(next.user.mustChangePassword).toBe(false);
    await expect(service.requireUsableUser(next.token)).resolves.toBeTruthy();
  });
});

describe("kendi parolasını değiştirme", () => {
  let profile: UserProfile;

  beforeEach(async () => {
    profile = await createReadyUser("ayse");
  });

  it("mevcut parola doğruysa yeni parolayı belirler", async () => {
    await service.changeOwnPassword(userActor(profile), USER_PASSWORD, "YeniParola7Kasa");

    const updated = await backend.getProfile(profile.id);
    expect(updated?.mustChangePassword).toBe(false);
    await expect(service.login("ayse", "YeniParola7Kasa", CLIENT)).resolves.toBeTruthy();
  });

  it("eski parola artık çalışmaz", async () => {
    await service.changeOwnPassword(userActor(profile), USER_PASSWORD, "YeniParola7Kasa");
    await expect(service.login("ayse", USER_PASSWORD, CLIENT)).rejects.toBeInstanceOf(AppError);
  });

  it("mevcut parola yanlışsa reddeder", async () => {
    await expect(
      service.changeOwnPassword(userActor(profile), "YanlisParola1", "YeniParola7Kasa"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("zayıf yeni parolayı reddeder", async () => {
    await expect(
      service.changeOwnPassword(userActor(profile), USER_PASSWORD, "kisa1"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("aynı parolayı tekrar kullanmayı reddeder", async () => {
    await expect(
      service.changeOwnPassword(userActor(profile), USER_PASSWORD, USER_PASSWORD),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("değişiklik sonrası diğer cihazlardaki oturumlar düşer", async () => {
    const first = await service.login("ayse", USER_PASSWORD, CLIENT);
    const second = await service.login("ayse", USER_PASSWORD, "10.0.0.5");

    await service.changeOwnPassword(userActor(profile), USER_PASSWORD, "YeniParola7Kasa");

    expect(await service.resolveSession(first.token)).toBeNull();
    expect(await service.resolveSession(second.token)).toBeNull();
  });
});
