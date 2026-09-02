import { beforeEach, describe, expect, it } from "vitest";

import { LoginRateLimiter } from "@/auth/rate-limit";
import type { UserProfile } from "@/auth/types";
import { AppError } from "@/server/auth/errors";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { makeInput } from "./helpers";

const ADMIN_PASSWORD = "Yonetici7Kasa";
const USER_PASSWORD = "Kuyumcu7Defter";
const CLIENT = "127.0.0.1";

let backend: LocalAuthBackend;
let service: AuthService;
let admin: UserProfile;

async function createUserAccount(username: string, password = USER_PASSWORD) {
  return service.createUser(admin, {
    username,
    displayName: `${username} Kullanıcı`,
    temporaryPassword: password,
  });
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new AuthService(backend, {
    rateLimiter: new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000, baseLockMs: 30_000 }),
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
    const unknown = await service.login("olmayankullanici", "Herhangi7Parola", CLIENT).catch(
      (error: AppError) => error.message,
    );
    const wrong = await service
      .login("yonetici", "YanlisParola1", "10.0.0.1")
      .catch((error: AppError) => error.message);

    expect(unknown).toBe(wrong);
    expect(unknown).toBe("Kullanıcı adı veya parola hatalı.");
  });

  it("pasif kullanıcı giriş yapamaz ve ayrı bir ipucu verilmez", async () => {
    const user = await createUserAccount("ayse");
    await service.setUserStatus(admin, user.id, "inactive");

    await expect(service.login("ayse", USER_PASSWORD, CLIENT)).rejects.toMatchObject({
      message: "Kullanıcı adı veya parola hatalı.",
    });
  });

  it("yeniden aktifleştirilen kullanıcı tekrar giriş yapabilir", async () => {
    const user = await createUserAccount("ayse");
    await service.setUserStatus(admin, user.id, "inactive");
    await service.setUserStatus(admin, user.id, "active");

    const result = await service.login("ayse", USER_PASSWORD, CLIENT);
    expect(result.user.username).toBe("ayse");
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
    // Başka bir istemciden gelen doğru giriş engellenmez.
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
    const profile = await service.resolveSession(token);
    expect(profile?.id).toBe(admin.id);
  });

  it("çıkış yapınca oturum geçersiz olur", async () => {
    const { token } = await service.login("yonetici", ADMIN_PASSWORD, CLIENT);
    await service.logout(token);
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("pasifleştirme mevcut oturumu anında düşürür", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);
    const { token } = await service.login("ayse", USER_PASSWORD, CLIENT);
    expect(await service.resolveSession(token)).not.toBeNull();

    await service.setUserStatus(admin, user.id, "inactive");
    expect(await service.resolveSession(token)).toBeNull();
  });

  it("geçersiz jeton için oturum yoktur", async () => {
    expect(await service.resolveSession("uydurma-jeton")).toBeNull();
    expect(await service.resolveSession(null)).toBeNull();
  });

  it("requireAdmin normal kullanıcıyı reddeder", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);
    const { token } = await service.login("ayse", USER_PASSWORD, CLIENT);

    await expect(service.requireAdmin(token)).rejects.toMatchObject({ status: 403 });
    await expect(service.requireUser(token)).resolves.toMatchObject({ username: "ayse" });
  });
});

describe("kendi parolasını değiştirme", () => {
  let user: UserProfile;

  beforeEach(async () => {
    user = await createUserAccount("ayse");
  });

  it("mevcut parola doğruysa yeni parolayı belirler", async () => {
    await service.changeOwnPassword(user, USER_PASSWORD, "YeniParola7Kasa");

    const updated = await backend.getProfile(user.id);
    expect(updated?.mustChangePassword).toBe(false);
    await expect(service.login("ayse", "YeniParola7Kasa", CLIENT)).resolves.toBeTruthy();
  });

  it("eski parola artık çalışmaz", async () => {
    await service.changeOwnPassword(user, USER_PASSWORD, "YeniParola7Kasa");
    await expect(service.login("ayse", USER_PASSWORD, CLIENT)).rejects.toBeInstanceOf(AppError);
  });

  it("mevcut parola yanlışsa reddeder", async () => {
    await expect(
      service.changeOwnPassword(user, "YanlisParola1", "YeniParola7Kasa"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("zayıf yeni parolayı reddeder", async () => {
    await expect(service.changeOwnPassword(user, USER_PASSWORD, "kisa1")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("aynı parolayı tekrar kullanmayı reddeder", async () => {
    await expect(
      service.changeOwnPassword(user, USER_PASSWORD, USER_PASSWORD),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("değişiklik sonrası diğer cihazlardaki oturumlar düşer", async () => {
    await backend.setMustChangePassword(user.id, false);
    const first = await service.login("ayse", USER_PASSWORD, CLIENT);
    const second = await service.login("ayse", USER_PASSWORD, "10.0.0.5");

    await service.changeOwnPassword(user, USER_PASSWORD, "YeniParola7Kasa");

    expect(await service.resolveSession(first.token)).toBeNull();
    expect(await service.resolveSession(second.token)).toBeNull();
  });
});

describe("yönetici: kullanıcı oluşturma", () => {
  it("yeni kullanıcı oluşturur ve parola değiştirmeye zorlar", async () => {
    const created = await createUserAccount("ayse");

    expect(created.username).toBe("ayse");
    expect(created.role).toBe("user");
    expect(created.status).toBe("active");
    expect(created.mustChangePassword).toBe(true);
  });

  it("oluşturulan hesap YÖNETİCİ olamaz (rol istemciden alınmaz)", async () => {
    const created = await service.createUser(admin, {
      username: "sahte.admin",
      displayName: "Rol Denemesi",
      // Rol alanı sözleşmede yoktur; gönderilse bile yok sayılır.
      temporaryPassword: USER_PASSWORD,
    } as { username: string; displayName: string; temporaryPassword: string });

    expect(created.role).toBe("user");
  });

  it("aynı kullanıcı adının farklı harf varyasyonu oluşturulamaz", async () => {
    await createUserAccount("ayse");

    await expect(
      service.createUser(admin, {
        username: "AYSE",
        displayName: "Kopya Hesap",
        temporaryPassword: USER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.createUser(admin, {
        username: "Ayşe",
        displayName: "Kopya Hesap",
        temporaryPassword: USER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("geçersiz kullanıcı adını reddeder", async () => {
    await expect(
      service.createUser(admin, {
        username: "ge çersiz",
        displayName: "Test Kullanıcı",
        temporaryPassword: USER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("zayıf geçici parolayı reddeder", async () => {
    await expect(
      service.createUser(admin, {
        username: "veli",
        displayName: "Veli Kullanıcı",
        temporaryPassword: "12345",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("geçersiz görünen adı reddeder", async () => {
    await expect(
      service.createUser(admin, {
        username: "veli",
        displayName: "V",
        temporaryPassword: USER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("yönetici: yetkilendirme", () => {
  let normalUser: UserProfile;

  beforeEach(async () => {
    normalUser = await createUserAccount("ayse");
  });

  it("normal kullanıcı kullanıcı listesine erişemez", async () => {
    await expect(service.listUsers(normalUser)).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı başka kullanıcı oluşturamaz", async () => {
    await expect(
      service.createUser(normalUser, {
        username: "veli",
        displayName: "Veli Kullanıcı",
        temporaryPassword: USER_PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı başka kullanıcının portföyünü okuyamaz", async () => {
    const other = await createUserAccount("veli");
    await expect(service.getUserPortfolio(normalUser, other.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("normal kullanıcı denetim kayıtlarını göremez", async () => {
    await expect(service.listAudit(normalUser)).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı hesap durumu değiştiremez", async () => {
    await expect(
      service.setUserStatus(normalUser, admin.id, "inactive"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı parola sıfırlayamaz", async () => {
    await expect(
      service.resetUserPassword(normalUser, admin.id, "BaskaParola7Kasa"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı kullanıcı silemez", async () => {
    await expect(service.deleteUser(normalUser, admin.id, "yonetici")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("kullanıcı verileri hesap bazında ayrışır", async () => {
    const other = await createUserAccount("veli");
    await backend.createTransaction(normalUser.id, makeInput({ quantity: 5 }));

    expect(await backend.listTransactions(normalUser.id)).toHaveLength(1);
    expect(await backend.listTransactions(other.id)).toHaveLength(0);
  });
});

describe("yönetici: parola sıfırlama", () => {
  it("yeni geçici parola atar ve değiştirmeye zorlar", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);

    const updated = await service.resetUserPassword(admin, user.id, "GeciciParola7Kasa");

    expect(updated.mustChangePassword).toBe(true);
    await expect(service.login("ayse", "GeciciParola7Kasa", CLIENT)).resolves.toBeTruthy();
    await expect(service.login("ayse", USER_PASSWORD, "10.0.0.7")).rejects.toBeInstanceOf(AppError);
  });

  it("sıfırlama tüm aktif oturumları geçersiz kılar", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);
    const session = await service.login("ayse", USER_PASSWORD, CLIENT);

    await service.resetUserPassword(admin, user.id, "GeciciParola7Kasa");
    expect(await service.resolveSession(session.token)).toBeNull();
  });

  it("zayıf geçici parolayı reddeder", async () => {
    const user = await createUserAccount("ayse");
    await expect(service.resetUserPassword(admin, user.id, "abc")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("yönetici mevcut parolayı hiçbir uçtan göremez", async () => {
    const user = await createUserAccount("ayse");
    const detail = await service.getUserDetail(admin, user.id);
    const view = await service.getUserPortfolio(admin, user.id);

    const serialized = JSON.stringify({ detail, view });
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized.toLowerCase()).not.toContain("password_hash");
    expect(Object.keys(detail)).not.toContain("passwordHash");
    // Kullanıcı listesinde de parola alanı yoktur.
    const list = await service.listUsers(admin);
    expect(JSON.stringify(list)).not.toContain(USER_PASSWORD);
  });
});

describe("yönetici: pasifleştirme ve silme", () => {
  it("kendi hesabını pasifleştiremez", async () => {
    await expect(service.setUserStatus(admin, admin.id, "inactive")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("son aktif yönetici pasifleştirilemez", async () => {
    const second = await backend.createUser({
      username: "yonetici2",
      displayName: "İkinci Yönetici",
      temporaryPassword: ADMIN_PASSWORD,
      role: "admin",
    });
    // İki yönetici varken pasifleştirme mümkündür.
    await expect(service.setUserStatus(admin, second.id, "inactive")).resolves.toBeTruthy();
    // Tek yönetici kaldığında kendini de silemez/pasifleştiremez.
    await expect(service.setUserStatus(admin, admin.id, "inactive")).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("onay yazılmadan kalıcı silme çalışmaz", async () => {
    const user = await createUserAccount("ayse");

    await expect(service.deleteUser(admin, user.id, "")).rejects.toMatchObject({ status: 400 });
    await expect(service.deleteUser(admin, user.id, "yanlisad")).rejects.toMatchObject({
      status: 400,
    });
    expect(await backend.getProfile(user.id)).not.toBeNull();
  });

  it("kullanıcı adı birebir yazıldığında siler", async () => {
    const user = await createUserAccount("ayse");
    await backend.createTransaction(user.id, makeInput({ quantity: 2 }));

    await service.deleteUser(admin, user.id, "AYSE");

    expect(await backend.getProfile(user.id)).toBeNull();
    expect(await backend.listTransactions(user.id)).toHaveLength(0);
  });

  it("kendi hesabını silemez", async () => {
    await expect(service.deleteUser(admin, admin.id, "yonetici")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("yönetici: portföy görüntüleme", () => {
  it("kullanıcının portföy özetini hesaplar", async () => {
    const user = await createUserAccount("ayse");
    await backend.createTransaction(user.id, makeInput({ quantity: 10, unitPrice: 5000 }));

    const view = await service.getUserPortfolio(admin, user.id);

    expect(view.user.username).toBe("ayse");
    expect(view.transactions).toHaveLength(1);
    expect(view.summary.totalCostBasis).toBe(50_000);
    expect(view.summary.totalLiquidationValue).toBeGreaterThan(0);
    expect(view.summary.totalRepurchaseValue).toBeGreaterThan(view.summary.totalLiquidationValue);
  });

  it("ilk sürümde yönetici kullanıcı adına düzenleme yapamaz", async () => {
    const user = await createUserAccount("ayse");
    const view = await service.getUserPortfolio(admin, user.id);
    expect(view.canEdit).toBe(false);
  });

  it("olmayan kullanıcı için 404 döner", async () => {
    await expect(service.getUserPortfolio(admin, "yok-boyle-id")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("denetim kaydı (audit log)", () => {
  it("kullanıcı oluşturmayı kaydeder", async () => {
    const created = await createUserAccount("ayse");
    const logs = await service.listAudit(admin);
    const entry = logs.find((log) => log.action === "user.create" && log.targetUserId === created.id);

    expect(entry).toBeDefined();
    expect(entry?.success).toBe(true);
    expect(entry?.adminUserId).toBe(admin.id);
    expect(entry?.adminUsername).toBe("yonetici");
    expect(entry?.createdAt).toBeTruthy();
  });

  it("pasifleştirme, aktifleştirme ve parola sıfırlamayı kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await service.setUserStatus(admin, user.id, "inactive");
    await service.setUserStatus(admin, user.id, "active");
    await service.resetUserPassword(admin, user.id, "GeciciParola7Kasa");

    const actions = (await service.listAudit(admin)).map((log) => log.action);
    expect(actions).toContain("user.deactivate");
    expect(actions).toContain("user.activate");
    expect(actions).toContain("user.password_reset");
  });

  it("kullanıcı ve portföy görüntülemeyi kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await service.getUserDetail(admin, user.id);
    await service.getUserPortfolio(admin, user.id);

    const actions = (await service.listAudit(admin)).map((log) => log.action);
    expect(actions).toContain("user.view");
    expect(actions).toContain("user.portfolio_view");
  });

  it("başarısız silme girişimini de kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await service.deleteUser(admin, user.id, "yanlisad").catch(() => undefined);

    const attempt = (await service.listAudit(admin)).find(
      (log) => log.action === "user.delete_attempt",
    );
    expect(attempt?.success).toBe(false);
    expect(attempt?.metadata.reason).toBe("confirmation_mismatch");
  });

  it("başarılı kalıcı silmeyi kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await service.deleteUser(admin, user.id, "ayse");

    const logs = await service.listAudit(admin);
    expect(logs.some((log) => log.action === "user.delete_attempt" && log.success)).toBe(true);
    expect(logs.some((log) => log.action === "user.delete" && log.success)).toBe(true);
  });

  it("denetim kaydına parola veya finansal içerik yazılmaz", async () => {
    const user = await createUserAccount("ayse");
    await backend.createTransaction(user.id, makeInput({ quantity: 10, unitPrice: 5000 }));
    await service.getUserPortfolio(admin, user.id);
    await service.resetUserPassword(admin, user.id, "GeciciParola7Kasa");

    const serialized = JSON.stringify(await service.listAudit(admin));
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized).not.toContain("GeciciParola7Kasa");
    expect(serialized).not.toContain("50000");
    expect(serialized).not.toContain("5000");
  });

  it("yetkisiz erişim denemesinde işlem gerçekleşmez", async () => {
    const normalUser = await createUserAccount("ayse");
    await service.createUser(normalUser, {
      username: "veli",
      displayName: "Veli Kullanıcı",
      temporaryPassword: USER_PASSWORD,
    }).catch(() => undefined);

    expect(await backend.findProfileByUsername("veli")).toBeNull();
  });
});
