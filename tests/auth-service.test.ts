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
  const pair = { maxAttempts: 3, windowMs: 60_000, baseLockMs: 30_000, maxLockMs: 120_000 };
  service = new AuthService(backend, {
    rateLimiter: new MemoryLoginRateLimiter("test-pepper"),
    // Testte kombinasyon sayacı 3 denemede kilitlenir; global sayaçlar geniş kalır.
    loginRateLimits: {
      pair,
      ip: { ...pair, maxAttempts: 20 },
      username: { ...pair, maxAttempts: 10 },
    },
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

    // Bu cihazdaki oturum korunur; yeniden giriş GEREKMEZ ve korumalı uçlar açılır.
    await expect(service.requireUsableUser(pendingToken)).resolves.toMatchObject({
      profile: { mustChangePassword: false },
    });

    // Yeni parola başka cihazda da çalışır.
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

// ---------------------------------------------------------------------------

/**
 * HERKESE AÇIK KAYIT
 *
 * Ürün kararı (sahibi verdi): siteye giren herkes kendi hesabını açabilir.
 * Uç internete açık olduğu için korumaların TAM listesi burada sabitlenir;
 * biri gevşerse test düşer.
 */
describe("herkese açık kayıt", () => {
  const NEW_PASSWORD = "Kuyumcu7Defter";

  function input(overrides: Record<string, string> = {}) {
    return {
      username: "yenikullanici",
      displayName: "Yeni Kullanıcı",
      password: NEW_PASSWORD,
      passwordConfirm: NEW_PASSWORD,
      ...overrides,
    };
  }

  it("hesap açılır ve parola değiştirme İSTENMEZ (parolayı kullanıcı seçti)", async () => {
    const created = await service.register(input(), CLIENT);
    expect(created.username).toBe("yenikullanici");
    expect(created.role).toBe("user");
    expect(created.mustChangePassword).toBe(false);

    // Kayıttan sonra aynı parolayla giriş yapabilmeli.
    const result = await service.login("yenikullanici", NEW_PASSWORD, CLIENT);
    expect(result.user.username).toBe("yenikullanici");
  });

  /*
   * ROL İSTEMCİDEN ALINMAZ. Gövdeye `role: "admin"` konsa bile okunmaz;
   * `register` böyle bir alan kabul etmez ve her kayıt `user` olur.
   */
  it("kayıtla yönetici olunamaz", async () => {
    const created = await service.register(
      { ...input(), ...({ role: "admin" } as Record<string, string>) },
      CLIENT,
    );
    expect(created.role).toBe("user");
  });

  it("parola tekrarı SUNUCUDA denetlenir", async () => {
    await expect(
      service.register(input({ passwordConfirm: "BaskaBirSey7" }), CLIENT),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("zayıf parola reddedilir (giriş ile AYNI politika)", async () => {
    await expect(
      service.register(input({ password: "1234", passwordConfirm: "1234" }), CLIENT),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("ayrılmış kullanıcı adı alınamaz", async () => {
    // Ayrılmış adlar: root, system, support, api, null, undefined.
    await expect(service.register(input({ username: "support" }), CLIENT)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("aynı kullanıcı adı ikinci kez alınamaz", async () => {
    await service.register(input(), CLIENT);
    await expect(service.register(input(), CLIENT)).rejects.toMatchObject({ status: 409 });
  });

  /*
   * Uç internete açıktır: hız sınırı OLMAZSA otomatik araçlar sınırsız hesap
   * açar. Kayıt sayaçları GİRİŞ sayaçlarından ayrıdır.
   */
  it("hız sınırına tabidir", async () => {
    await service.register(input(), CLIENT);
    const attempts: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const error = await service.register(input(), CLIENT).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AppError);
      attempts.push((error as AppError).status);
    }
    // Bir noktadan sonra 409 (çakışma) değil 429 (çok fazla istek) döner.
    expect(attempts).toContain(429);
  });

  /*
   * BAŞARILI KAYIT DA SAYILIR.
   *
   * Giriş sayacı yalnızca başarısız denemeyi sayar ve bu doğrudur. Kayıtta
   * aynı kural, her seferinde YENİ bir kullanıcı adı kullanan bir betiğe
   * sınırsız hesap açtırırdı: hiçbir deneme "başarısız" olmadığı için hiçbir
   * sayaç ilerlemezdi.
   */
  it("her seferinde farklı kullanıcı adıyla sınırsız hesap açılamaz", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await service
        .register(input({ username: `yenikullanici${String(attempt)}` }), CLIENT)
        .catch((cause: unknown) => cause);
      statuses.push(result instanceof AppError ? result.status : 201);
    }
    expect(statuses).toContain(429);
  });

  /*
   * KAYIT DENEMESİ GİRİŞİ KİLİTLEYEMEZ.
   *
   * Sayaçlar ortak olsaydı saldırgan, bilinen bir kullanıcı adıyla arka arkaya
   * "üye ol" isteği göndererek o adın giriş sayacını doldurur ve hesabın
   * gerçek sahibini dışarıda bırakırdı.
   */
  it("kayıt denemeleri mevcut kullanıcının girişini kilitlemez", async () => {
    const victim = input({ username: "kurban" });
    await service.register(victim, CLIENT);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await service.register(victim, CLIENT).catch(() => undefined);
    }

    const session = await service.login(victim.username, victim.password, CLIENT);
    expect(session.user.username).toBe("kurban");
  });
});
