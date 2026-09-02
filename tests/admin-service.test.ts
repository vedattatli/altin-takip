import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { AuthService } from "@/server/auth/service";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";
import { adminActor, scopeOf } from "./actors";
import { dec, parseLedgerCommand } from "@/domain/accounting";
import { buyCommand } from "./helpers";

const ADMIN_PASSWORD = "Yonetici7Kasa";

function requestOf(command: Parameters<typeof parseLedgerCommand>[0]) {
  const parsed = parseLedgerCommand(command);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.request;
}
const USER_PASSWORD = "Kuyumcu7Defter";
const CLIENT = "127.0.0.1";

let backend: LocalAuthBackend;
let auth: AuthService;
let admin: AdminService;
let adminProfile: UserProfile;

async function createUserAccount(username: string) {
  return admin.createUser(adminActor(adminProfile), {
    username,
    displayName: `${username} Kullanıcı`,
    temporaryPassword: USER_PASSWORD,
  });
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  auth = new AuthService(backend, { rateLimiter: new MemoryLoginRateLimiter("test-pepper") });
  admin = new AdminService(backend);

  adminProfile = await backend.createUser({
    username: "yonetici",
    displayName: "Sistem Yöneticisi",
    temporaryPassword: ADMIN_PASSWORD,
    role: "admin",
  });
  adminProfile = await backend.setMustChangePassword(adminProfile.id, false);
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
    const created = await admin.createUser(adminActor(adminProfile), {
      username: "sahte.admin",
      displayName: "Rol Denemesi",
      temporaryPassword: USER_PASSWORD,
    });
    expect(created.role).toBe("user");
  });

  it("aynı kullanıcı adının farklı harf varyasyonu oluşturulamaz", async () => {
    await createUserAccount("ayse");

    for (const variant of ["AYSE", "Ayşe"]) {
      await expect(
        admin.createUser(adminActor(adminProfile), {
          username: variant,
          displayName: "Kopya Hesap",
          temporaryPassword: USER_PASSWORD,
        }),
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it("geçersiz kullanıcı adını, zayıf parolayı ve kısa görünen adı reddeder", async () => {
    const cases = [
      { username: "ge çersiz", displayName: "Test Kullanıcı", temporaryPassword: USER_PASSWORD },
      { username: "veli", displayName: "Veli Kullanıcı", temporaryPassword: "12345" },
      { username: "veli", displayName: "V", temporaryPassword: USER_PASSWORD },
    ];
    for (const input of cases) {
      await expect(admin.createUser(adminActor(adminProfile), input)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});

describe("yönetici: parola sıfırlama", () => {
  it("yeni geçici parola atar ve değiştirmeye zorlar", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);

    const updated = await admin.resetUserPassword(
      adminActor(adminProfile),
      user.id,
      "GeciciParola7Kasa",
    );

    expect(updated.mustChangePassword).toBe(true);
    await expect(auth.login("ayse", "GeciciParola7Kasa", CLIENT)).resolves.toBeTruthy();
    await expect(auth.login("ayse", USER_PASSWORD, "10.0.0.7")).rejects.toBeTruthy();
  });

  it("sıfırlama tüm aktif oturumları geçersiz kılar", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);
    const session = await auth.login("ayse", USER_PASSWORD, CLIENT);

    await admin.resetUserPassword(adminActor(adminProfile), user.id, "GeciciParola7Kasa");
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it("zayıf geçici parolayı reddeder", async () => {
    const user = await createUserAccount("ayse");
    await expect(
      admin.resetUserPassword(adminActor(adminProfile), user.id, "abc"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("yönetici mevcut parolayı hiçbir uçtan göremez", async () => {
    const user = await createUserAccount("ayse");
    const detail = await admin.getUserDetail(adminActor(adminProfile), user.id);
    const view = await admin.getUserPortfolio(adminActor(adminProfile), user.id);
    const list = await admin.listUsers(adminActor(adminProfile));

    const serialized = JSON.stringify({ detail, view, list });
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized.toLowerCase()).not.toContain("passwordhash");
    expect(serialized.toLowerCase()).not.toContain("password_hash");
  });
});

describe("yönetici: pasifleştirme ve silme", () => {
  it("pasifleştirme oturumları düşürür", async () => {
    const user = await createUserAccount("ayse");
    await backend.setMustChangePassword(user.id, false);
    const session = await auth.login("ayse", USER_PASSWORD, CLIENT);

    await admin.setUserStatus(adminActor(adminProfile), user.id, "inactive");
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it("kendi hesabını pasifleştiremez", async () => {
    await expect(
      admin.setUserStatus(adminActor(adminProfile), adminProfile.id, "inactive"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("son aktif yönetici pasifleştirilemez", async () => {
    const second = await backend.createUser({
      username: "yonetici2",
      displayName: "İkinci Yönetici",
      temporaryPassword: ADMIN_PASSWORD,
      role: "admin",
    });
    await expect(
      admin.setUserStatus(adminActor(adminProfile), second.id, "inactive"),
    ).resolves.toBeTruthy();
    await expect(
      admin.setUserStatus(adminActor(adminProfile), adminProfile.id, "inactive"),
    ).rejects.toBeTruthy();
  });

  it("onay yazılmadan kalıcı silme çalışmaz", async () => {
    const user = await createUserAccount("ayse");

    for (const confirmation of ["", "yanlisad"]) {
      await expect(
        admin.deleteUser(adminActor(adminProfile), user.id, confirmation),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(await backend.getProfile(user.id)).not.toBeNull();
  });

  it("kullanıcı adı birebir yazıldığında siler", async () => {
    const user = await createUserAccount("ayse");
    await backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ quantity: "2" })));

    const result = await admin.deleteUser(adminActor(adminProfile), user.id, "AYSE");

    expect(result.deleted).toBe(true);
    expect(result.auditWriteFailed).toBe(false);
    expect(await backend.getProfile(user.id)).toBeNull();
    expect(await backend.listLedger(scopeOf(user))).toHaveLength(0);
  });

  it("kendi hesabını silemez", async () => {
    await expect(
      admin.deleteUser(adminActor(adminProfile), adminProfile.id, "yonetici"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("yönetici: portföy görüntüleme", () => {
  it("kullanıcının portföy özetini hesaplar", async () => {
    const user = await createUserAccount("ayse");
    await backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ quantity: "10", unitPrice: "5000" })));

    const view = await admin.getUserPortfolio(adminActor(adminProfile), user.id);

    expect(view.user.username).toBe("ayse");
    expect(view.ledger).toHaveLength(1);
    expect(view.summary.totalRemainingCostBasis).toBe("50000");
    expect(dec(view.summary.totalReplacementValue).greaterThan(dec(view.summary.totalLiquidationValue))).toBe(true);
  });

  it("yönetici yalnızca okur: kullanıcı adına düzenleme yetkisi yoktur ve servis mutation sunmaz", async () => {
    const user = await createUserAccount("ayse");
    const view = await admin.getUserPortfolio(adminActor(adminProfile), user.id);
    expect(view.canEdit).toBe(false);
    const adminMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(admin));
    expect(adminMethods.some((name) => /transaction|ledger|buy|sell|void|replace/i.test(name))).toBe(false);
  });

  it("olmayan kullanıcı için 404 döner", async () => {
    await expect(
      admin.getUserPortfolio(adminActor(adminProfile), "yok-boyle-id"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("denetim kaydı (audit log)", () => {
  it("kullanıcı oluşturmayı kaydeder", async () => {
    const created = await createUserAccount("ayse");
    const logs = await admin.listAudit(adminActor(adminProfile));
    const entry = logs.find(
      (log) => log.action === "user.create" && log.targetUserId === created.id,
    );

    expect(entry).toBeDefined();
    expect(entry?.success).toBe(true);
    expect(entry?.adminUserId).toBe(adminProfile.id);
    expect(entry?.adminUsername).toBe("yonetici");
  });

  it("pasifleştirme, aktifleştirme, parola sıfırlama ve görüntülemeyi kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await admin.setUserStatus(adminActor(adminProfile), user.id, "inactive");
    await admin.setUserStatus(adminActor(adminProfile), user.id, "active");
    await admin.resetUserPassword(adminActor(adminProfile), user.id, "GeciciParola7Kasa");
    await admin.getUserDetail(adminActor(adminProfile), user.id);
    await admin.getUserPortfolio(adminActor(adminProfile), user.id);

    const actions = (await admin.listAudit(adminActor(adminProfile))).map((log) => log.action);
    for (const expected of [
      "user.deactivate",
      "user.activate",
      "user.password_reset",
      "user.view",
      "user.portfolio_view",
    ]) {
      expect(actions).toContain(expected);
    }
  });

  it("başarısız silme girişimini de kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await admin.deleteUser(adminActor(adminProfile), user.id, "yanlisad").catch(() => undefined);

    const attempt = (await admin.listAudit(adminActor(adminProfile))).find(
      (log) => log.action === "user.delete_attempt",
    );
    expect(attempt?.success).toBe(false);
    expect(attempt?.metadata.reason).toBe("confirmation_mismatch");
  });

  it("başarılı kalıcı silmeyi kaydeder", async () => {
    const user = await createUserAccount("ayse");
    await admin.deleteUser(adminActor(adminProfile), user.id, "ayse");

    const logs = await admin.listAudit(adminActor(adminProfile));
    expect(logs.some((log) => log.action === "user.delete_attempt" && log.success)).toBe(true);
    expect(logs.some((log) => log.action === "user.delete" && log.success)).toBe(true);
  });

  it("silme sırasında hata olursa başarısızlık dürüstçe kaydedilir", async () => {
    const user = await createUserAccount("ayse");
    const original = backend.deleteUser.bind(backend);
    backend.deleteUser = async () => {
      throw new Error("veritabanı hatası");
    };

    await expect(
      admin.deleteUser(adminActor(adminProfile), user.id, "ayse"),
    ).rejects.toThrow(/veritabanı hatası/);

    backend.deleteUser = original;
    const logs = await admin.listAudit(adminActor(adminProfile));
    const failure = logs.find((log) => log.action === "user.delete" && !log.success);
    expect(failure?.metadata.reason).toBe("backend_error");
  });

  it("son denetim kaydı yazılamazsa bu durum gizlenmez", async () => {
    const user = await createUserAccount("ayse");
    const original = backend.appendAudit.bind(backend);
    let calls = 0;
    backend.appendAudit = async (entry) => {
      calls += 1;
      // Son (user.delete) kaydı yazılamıyormuş gibi davranılır.
      if (entry.action === "user.delete") throw new Error("audit yazılamadı");
      return original(entry);
    };

    const result = await admin.deleteUser(adminActor(adminProfile), user.id, "ayse");
    backend.appendAudit = original;

    expect(calls).toBeGreaterThan(0);
    expect(result.deleted).toBe(true);
    // Sessiz kalınmaz: çağıran taraf bunu görür.
    expect(result.auditWriteFailed).toBe(true);
  });

  it("denetim kaydına parola veya finansal içerik yazılmaz", async () => {
    const user = await createUserAccount("ayse");
    await backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ quantity: "10", unitPrice: "5000" })));
    await admin.getUserPortfolio(adminActor(adminProfile), user.id);
    await admin.resetUserPassword(adminActor(adminProfile), user.id, "GeciciParola7Kasa");

    const serialized = JSON.stringify(await admin.listAudit(adminActor(adminProfile)));
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized).not.toContain("GeciciParola7Kasa");
    expect(serialized).not.toContain("50000");
    expect(serialized).not.toContain("5000");
  });
});
