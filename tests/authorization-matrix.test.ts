import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { adminActor, scopeOf, userActor } from "./actors";
import { parseLedgerCommand } from "@/domain/accounting";
import { buyCommand } from "./helpers";

/**
 * YETKİLENDİRME MATRİSİ
 *
 * Bu dosya iki şeyi birden doğrular:
 *  1. Statik: her API route'unun hangi guard'ı kullandığı (matris tablosu).
 *  2. Davranışsal: servis katmanının kullanıcı verilerini gerçekten ayırdığı.
 *
 * Hatırlatma: BFF service_role ile bağlandığı için RLS bu katmanda uygulanmaz.
 * Birincil güvenlik sınırı burada test edilen actor authorization'dır.
 */

const USER_PASSWORD = "Kuyumcu7Defter";

// ---------------------------------------------------------------- statik matris

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const ROUTE_FILES = walk(join("src", "app", "api")).filter((file) => file.endsWith("route.ts"));

/** Yorumları ayıklar; denetlenen şey açıklama metni değil, çalışan koddur. */
function readCode(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

type Guard =
  | "public"
  | "public-health"
  | "authenticated"
  | "usable"
  | "admin"
  | "admin-mfa-setup"
  | "cron"
  | "worker-hmac";

/** Her uç için BEKLENEN guard. Yeni uç eklenince bu tablo da güncellenmelidir. */
const EXPECTED_GUARDS: Record<string, Guard> = {
  "auth/login/route.ts": "public",
  // Herkese acik kayit: guard yok, korumalar servis katmaninda (hiz siniri,
  // parola politikasi, ayrilmis ad reddi). Rol istemciden ALINMAZ.
  "auth/register/route.ts": "public",
  "auth/logout/route.ts": "public",
  "auth/session/route.ts": "public",
  // Geçici parolalı kullanıcı bu uçları kullanabilmelidir.
  "auth/change-password/route.ts": "authenticated",
  "auth/logout-all/route.ts": "authenticated",
  "portfolio/route.ts": "usable",
  "portfolio/history/route.ts": "usable",
  "portfolio/summary/route.ts": "usable",
  "portfolio/version/route.ts": "usable",
  "transactions/route.ts": "usable",
  "transactions/[id]/route.ts": "usable",
  "admin/users/route.ts": "admin",
  "admin/users/[id]/route.ts": "admin",
  "admin/users/[id]/password/route.ts": "admin",
  "admin/users/[id]/sessions/route.ts": "admin",
  "admin/users/[id]/sessions/[sessionId]/route.ts": "admin",
  "admin/audit/route.ts": "admin",
  // Sprint 3: fiyat kaynakları, ikinci faktör, veri hakları ve zamanlanmış alım.
  "price-sources/route.ts": "usable",
  "price-sources/compare/route.ts": "usable",
  "portfolio/export/route.ts": "usable",
  "account/deletion-request/route.ts": "usable",
  "admin/price-sources/route.ts": "admin",
  "admin/price-sources/[code]/route.ts": "admin",
  "admin/price-sources/[code]/refresh/route.ts": "admin",
  "admin/price-sources/[code]/test/route.ts": "admin",
  "admin/price-sources/quarantine/route.ts": "admin",
  "admin/price-sources/default/route.ts": "admin",
  "admin/price-sources/experimental/route.ts": "admin",
  "admin/price-sources/mappings/route.ts": "admin",
  "admin/users/[id]/mfa/route.ts": "admin",
  // İkinci faktör durumunu geçici parolalı yönetici de sorgulayabilmelidir.
  "auth/mfa/route.ts": "authenticated",
  // Kurulum/doğrulama uçları MFA henüz yokken de çalışmalıdır (admin rolü yeter).
  "auth/mfa/enroll/route.ts": "admin-mfa-setup",
  "auth/mfa/confirm/route.ts": "admin-mfa-setup",
  "auth/mfa/verify/route.ts": "admin-mfa-setup",
  // Zamanlanmış alım: oturum değil, paylaşılan secret ile korunur.
  "cron/price-ingestion/route.ts": "cron",
  // Günlük uygulama yedeği: aynı makine ucu modeli; secret yoksa KAPALI.
  "cron/backup/route.ts": "cron",
  // Sağlık kontrolü: kimliksiz yanıt yalındır; ayrıntı yalnızca cron secret'ıyla açılır.
  "health/route.ts": "public-health",
  // Kalıcı tarayıcı worker'ı: oturum değil, HMAC imzası + nonce + kira jetonu.
  "internal/price-worker/sarraf-screen/route.ts": "worker-hmac",
  "internal/price-worker/lease/route.ts": "worker-hmac",
};

function routeKey(file: string): string {
  return relative(join("src", "app", "api"), file).split(sep).join("/");
}

function detectGuard(source: string): Guard {
  // Worker uçları tarayıcı oturumu yerine HMAC imzasıyla korunur.
  if (source.includes("verifyWorkerSignature")) return "worker-hmac";
  // Sağlık ucu secret'ı YALNIZCA ayrıntı seviyesini açar; erişimi kısıtlamaz.
  if (source.includes("detailAuthorized")) return "public-health";
  // Makine uçları tarayıcı oturumu yerine paylaşılan secret ile korunur.
  if (source.includes("machineRoute")) return "cron";
  if (source.includes("PRICE_CRON_SECRET")) return "cron";
  if (source.includes("requireAdminForMfaSetup")) return "admin-mfa-setup";
  if (source.includes("requireCurrentAdmin")) return "admin";
  if (source.includes("requireUsableUser")) return "usable";
  if (source.includes("requireAuthenticatedUser")) return "authenticated";
  return "public";
}

describe("API yetkilendirme matrisi", () => {
  it("her route dosyası matriste tanımlıdır", () => {
    const keys = ROUTE_FILES.map(routeKey).sort();
    expect(keys).toEqual(Object.keys(EXPECTED_GUARDS).sort());
  });

  it("her route beklenen guard'ı kullanır", () => {
    for (const file of ROUTE_FILES) {
      const key = routeKey(file);
      const source = readCode(file);
      expect(detectGuard(source), `${key} beklenen guard`).toBe(EXPECTED_GUARDS[key]);
    }
  });

  it("her route merkezi sarmalayıcıyı kullanır", () => {
    for (const file of ROUTE_FILES) {
      const source = readFileSync(file, "utf8");
      // Tarayıcı uçları apiRoute, makine (cron) uçları machineRoute kullanır.
      // İkisi de merkezîdir; ham handler export edilmesi yasaktır.
      // Worker uçları kendi imza doğrulamasını yapar; merkezî sarmalayıcı yerine
      // `verifyWorkerSignature` + nonce + kira jetonu zinciri kullanılır.
      const wrapped =
        source.includes("apiRoute") ||
        source.includes("machineRoute") ||
        source.includes("verifyWorkerSignature");
      expect(wrapped, `${routeKey(file)} merkezi sarmalayıcı kullanmalı`).toBe(true);
      // Ham export edilmiş handler yalnızca imzalı worker uçlarında olabilir.
      if (!source.includes("verifyWorkerSignature")) {
        expect(source, routeKey(file)).not.toMatch(/export async function (GET|POST|PUT|PATCH|DELETE)/);
      }
    }
  });

  it("normal kullanıcı uçları hedef kullanıcı kimliği KABUL ETMEZ", () => {
    const userRoutes = ROUTE_FILES.filter((file) => !routeKey(file).startsWith("admin/"));
    for (const file of userRoutes) {
      const source = readFileSync(file, "utf8");
      // Gövde veya sorgudan userId okunmamalı.
      expect(source, routeKey(file)).not.toMatch(/body\.userId|params\.userId|get\("userId"\)/);
    }
  });

  it("kullanıcı uçları admin servisini çağırmaz", () => {
    const userRoutes = ROUTE_FILES.filter((file) => !routeKey(file).startsWith("admin/"));
    for (const file of userRoutes) {
      expect(readFileSync(file, "utf8"), routeKey(file)).not.toContain("getAdminService");
    }
  });

  it("admin uçları kullanıcı portföy servisini çağırmaz", () => {
    const adminRoutes = ROUTE_FILES.filter((file) => routeKey(file).startsWith("admin/"));
    for (const file of adminRoutes) {
      expect(readFileSync(file, "utf8"), routeKey(file)).not.toContain(
        "getUserPortfolioService",
      );
    }
  });
});

// ------------------------------------------------------------ davranışsal ayrım

describe("kullanıcı verisi ayrımı", () => {
  let backend: LocalAuthBackend;
  let portfolio: UserPortfolioService;
  let admin: AdminService;
  let adminProfile: UserProfile;
  let userA: UserProfile;
  let userB: UserProfile;

  beforeEach(async () => {
    backend = new LocalAuthBackend({ inMemory: true });
    portfolio = new UserPortfolioService(backend);
    admin = new AdminService(backend);

    adminProfile = await backend.createUser({
      username: "yonetici",
      displayName: "Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    userA = await backend.createUser({
      username: "kullanicia",
      displayName: "Kullanıcı A",
      temporaryPassword: USER_PASSWORD,
      role: "user",
    });
    userB = await backend.createUser({
      username: "kullanicib",
      displayName: "Kullanıcı B",
      temporaryPassword: USER_PASSWORD,
      role: "user",
    });
  });

  it("kullanıcı yalnızca kendi işlemlerini görür", async () => {
    await portfolio.appendTransaction(userActor(userA), buyCommand({ quantity: "5" }));
    await portfolio.appendTransaction(userActor(userB), buyCommand({ quantity: "9" }));

    const aRows = await portfolio.listLedger(userActor(userA));
    const bRows = await portfolio.listLedger(userActor(userB));

    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0]!.quantity).toBe("5");
    expect(bRows[0]!.quantity).toBe("9");
  });

  it("kullanıcı başka kullanıcının işlemini kimlik tahminiyle iptal edemez", async () => {
    const created = await portfolio.appendTransaction(userActor(userB), buyCommand({ quantity: "3" }));

    await expect(portfolio.voidTransaction(userActor(userA), created.entry.id, "x")).rejects.toMatchObject({
      status: 404,
    });
    const rows = await portfolio.listLedger(userActor(userB));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ACTIVE");
  });

  it("kullanıcı başka kullanıcının işlemini düzeltemez veya okuyamaz", async () => {
    const created = await portfolio.appendTransaction(userActor(userB), buyCommand({ quantity: "3" }));

    await expect(
      portfolio.replaceTransaction(userActor(userA), created.entry.id, buyCommand({ quantity: "99" })),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await portfolio.listLedger(userActor(userB));
    expect(rows[0]!.quantity).toBe("3");
    expect((await portfolio.listLedger(userActor(userA))).some((entry) => entry.id === created.entry.id)).toBe(false);
  });

  it("kullanıcı portföyleri birbirinden ayrıdır", async () => {
    await portfolio.renamePortfolio(userActor(userA), { name: "A Portföyü" });
    await portfolio.renamePortfolio(userActor(userB), { name: "B Portföyü" });

    expect((await portfolio.getPortfolio(userActor(userA))).name).toBe("A Portföyü");
    expect((await portfolio.getPortfolio(userActor(userB))).name).toBe("B Portföyü");
  });

  /*
   * Yönetici artık başka kullanıcının FİNANSAL verisini hiç okumaz; hesap
   * görünümü yalnızca profil döner. `adminScope` yalnızca hesap yaşam döngüsü
   * (oturum kapatma, silme) için kullanılır.
   */
  it("yönetici hesap görünümünde finansal veri yoktur", async () => {
    await portfolio.appendTransaction(userActor(userA), buyCommand({ quantity: "7" }));

    const view = await admin.getUserAccount(adminActor(adminProfile), userA.id);
    expect(Object.keys(view)).toEqual(["user"]);
    expect(JSON.stringify(view)).not.toContain("quantity");
  });

  it("arka uç kapsamı kullanıcı kimliğine sıkıca bağlıdır", async () => {
    const parsed = parseLedgerCommand(buyCommand({ quantity: "2" }));
    if (!parsed.ok) throw new Error("komut geçersiz");
    await backend.appendLedgerEntry(scopeOf(userA), parsed.request);
    expect(await backend.listLedger(scopeOf(userA))).toHaveLength(1);
    expect(await backend.listLedger(scopeOf(userB))).toHaveLength(0);
    expect(await backend.listPositions(scopeOf(userB))).toHaveLength(0);
  });
});

// ---------------------------------------------------------- kaynak kod sınırı

describe("actor sınırının kaynak kodda korunması", () => {
  const SOURCE_FILES = walk("src").filter((file) => /\.(ts|tsx)$/.test(file));

  it("adminScope yalnızca admin servisinde çağrılır", () => {
    const callers = SOURCE_FILES.filter((file) => {
      const source = readCode(file);
      return /adminScope\(/.test(source) && !file.endsWith("actor.ts");
    });
    /*
     * Kapsam üretebilen dosyalar AÇIKÇA listelidir; yeni bir dosya eklenirse
     * test düşer.
     *
     * `admin-service.ts` listeden ÇIKTI: yönetici artık başka kullanıcının
     * finansal verisini okumuyor, dolayısıyla admin kapsamı da kurmuyor.
     * Geri eklenmesi, portföy okumasının geri gelmesi demektir.
     */
    expect(callers.sort()).toEqual(
      [
        join("src", "server", "prices", "price-source-service.ts"),
      ].sort(),
    );
  });

  it("ownScope yalnızca kullanıcı portföy servisinde çağrılır", () => {
    const callers = SOURCE_FILES.filter((file) => {
      const source = readCode(file);
      return /ownScope\(/.test(source) && !file.endsWith("actor.ts");
    });
    expect(callers.sort()).toEqual(
      [
        // Grafik serisi de kullanıcının KENDİ defterini okur; kapsamı route
        // değil servis kurar, böylece uç hedef kullanıcı kimliği alamaz.
        join("src", "server", "portfolio", "portfolio-history-service.ts"),
        join("src", "server", "portfolio", "user-portfolio-service.ts"),
        join("src", "server", "prices", "price-source-service.ts"),
      ].sort(),
    );
  });

  it("aktör fabrikaları yalnızca sunucu kimlik katmanında kullanılır", () => {
    const callers = SOURCE_FILES.filter((file) => {
      const source = readCode(file);
      return /createAdminActor\(|createUserActor\(/.test(source) && !file.endsWith("actor.ts");
    });
    expect(callers).toEqual([join("src", "server", "auth", "service.ts")]);
  });
});
