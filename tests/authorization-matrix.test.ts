import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { adminActor, scopeOf, userActor } from "./actors";
import { makeInput } from "./helpers";

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

type Guard = "public" | "authenticated" | "usable" | "admin";

/** Her uç için BEKLENEN guard. Yeni uç eklenince bu tablo da güncellenmelidir. */
const EXPECTED_GUARDS: Record<string, Guard> = {
  "auth/login/route.ts": "public",
  "auth/logout/route.ts": "public",
  "auth/session/route.ts": "public",
  // Geçici parolalı kullanıcı bu uçları kullanabilmelidir.
  "auth/change-password/route.ts": "authenticated",
  "auth/logout-all/route.ts": "authenticated",
  "portfolio/route.ts": "usable",
  "transactions/route.ts": "usable",
  "transactions/[id]/route.ts": "usable",
  "admin/users/route.ts": "admin",
  "admin/users/[id]/route.ts": "admin",
  "admin/users/[id]/password/route.ts": "admin",
  "admin/users/[id]/portfolio/route.ts": "admin",
  "admin/users/[id]/sessions/route.ts": "admin",
  "admin/users/[id]/sessions/[sessionId]/route.ts": "admin",
  "admin/audit/route.ts": "admin",
};

function routeKey(file: string): string {
  return relative(join("src", "app", "api"), file).split(sep).join("/");
}

function detectGuard(source: string): Guard {
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

  it("her route merkezi apiRoute sarmalayıcısını kullanır", () => {
    for (const file of ROUTE_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, routeKey(file)).toContain("apiRoute");
      // Ham export edilmiş handler kalmamalı; hepsi sarmalayıcıdan geçmeli.
      expect(source, routeKey(file)).not.toMatch(
        /export async function (GET|POST|PUT|PATCH|DELETE)/,
      );
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
    await portfolio.createTransaction(userActor(userA), makeInput({ quantity: 5 }));
    await portfolio.createTransaction(userActor(userB), makeInput({ quantity: 9 }));

    const aRows = await portfolio.listTransactions(userActor(userA));
    const bRows = await portfolio.listTransactions(userActor(userB));

    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].quantity).toBe(5);
    expect(bRows[0].quantity).toBe(9);
  });

  it("kullanıcı başka kullanıcının işlemini silemez", async () => {
    const created = await portfolio.createTransaction(userActor(userB), makeInput({ quantity: 3 }));

    await expect(portfolio.deleteTransaction(userActor(userA), created.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await portfolio.listTransactions(userActor(userB))).toHaveLength(1);
  });

  it("kullanıcı başka kullanıcının işlemini güncelleyemez", async () => {
    const created = await portfolio.createTransaction(userActor(userB), makeInput({ quantity: 3 }));

    await expect(
      portfolio.updateTransaction(userActor(userA), created.id, makeInput({ quantity: 99 })),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await portfolio.listTransactions(userActor(userB));
    expect(rows[0].quantity).toBe(3);
  });

  it("kullanıcı portföyleri birbirinden ayrıdır", async () => {
    await portfolio.renamePortfolio(userActor(userA), { name: "A Portföyü" });
    await portfolio.renamePortfolio(userActor(userB), { name: "B Portföyü" });

    expect((await portfolio.getPortfolio(userActor(userA))).name).toBe("A Portföyü");
    expect((await portfolio.getPortfolio(userActor(userB))).name).toBe("B Portföyü");
  });

  it("yönetici başka kullanıcının verisini adminScope ile okur", async () => {
    await portfolio.createTransaction(userActor(userA), makeInput({ quantity: 7 }));

    const view = await admin.getUserPortfolio(adminActor(adminProfile), userA.id);
    expect(view.transactions).toHaveLength(1);
    expect(view.canEdit).toBe(false);
  });

  it("arka uç kapsamı kullanıcı kimliğine sıkıca bağlıdır", async () => {
    await backend.createTransaction(scopeOf(userA), makeInput({ quantity: 2 }));
    expect(await backend.listTransactions(scopeOf(userA))).toHaveLength(1);
    expect(await backend.listTransactions(scopeOf(userB))).toHaveLength(0);
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
    expect(callers).toEqual([join("src", "server", "admin", "admin-service.ts")]);
  });

  it("ownScope yalnızca kullanıcı portföy servisinde çağrılır", () => {
    const callers = SOURCE_FILES.filter((file) => {
      const source = readCode(file);
      return /ownScope\(/.test(source) && !file.endsWith("actor.ts");
    });
    expect(callers).toEqual([
      join("src", "server", "portfolio", "user-portfolio-service.ts"),
    ]);
  });

  it("aktör fabrikaları yalnızca sunucu kimlik katmanında kullanılır", () => {
    const callers = SOURCE_FILES.filter((file) => {
      const source = readCode(file);
      return /createAdminActor\(|createUserActor\(/.test(source) && !file.endsWith("actor.ts");
    });
    expect(callers).toEqual([join("src", "server", "auth", "service.ts")]);
  });
});
