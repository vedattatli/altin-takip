import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { PortfolioNotProvisionedError } from "@/server/auth/backend";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { scopeOf, userActor } from "./actors";

/**
 * VARSAYILAN PORTFÖY PROVISIONING
 *
 * Portföy, profil oluşturulurken hazırlanır (Supabase'de AFTER INSERT
 * tetikleyicisi, yerel arka uçta aynı yazma adımı). GET /api/portfolio
 * HİÇBİR KOŞULDA veri oluşturmaz; eksik kayıt yalnızca yönetici onarımıyla
 * (provision_missing_defaults) tamamlanır.
 */

const PASSWORD = "Kuyumcu7Defter";

let backend: LocalAuthBackend;
let service: UserPortfolioService;
let ayse: UserProfile;
let writes: number;

type BackendInternals = {
  write: () => void;
  store: { portfolios: { userId: string }[] };
};

function internals(): BackendInternals {
  return backend as unknown as BackendInternals;
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new UserPortfolioService(backend);
  ayse = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe Kullanıcı",
    temporaryPassword: PASSWORD,
    role: "user",
  });
  ayse = await backend.setMustChangePassword(ayse.id, false);

  // Her yazma çağrısı sayılır: GET yolunun yazmadığı böyle kanıtlanır.
  writes = 0;
  const original = internals().write.bind(backend);
  internals().write = () => {
    writes += 1;
    original();
  };
});

describe("profil oluşturulunca portföy hazırlanır", () => {
  it("kullanıcı oluşturulduğu anda varsayılan portföyü vardır", async () => {
    const portfolio = await backend.getPortfolio(scopeOf(ayse));
    expect(portfolio.name).toBe("Portföyüm");
    expect(internals().store.portfolios.filter((row) => row.userId === ayse.id)).toHaveLength(1);
  });
});

describe("GET /api/portfolio yan etkisizdir", () => {
  it("portföy varken okuma hiçbir yazma yapmaz", async () => {
    await service.getPortfolio(userActor(ayse));
    await service.getPortfolio(userActor(ayse));
    expect(writes).toBe(0);
  });

  it("portföy YOKKEN okuma yine yazmaz ve açık hata verir", async () => {
    // Eksik provisioning durumu simüle edilir.
    internals().store.portfolios = [];

    await expect(backend.getPortfolio(scopeOf(ayse))).rejects.toBeInstanceOf(
      PortfolioNotProvisionedError,
    );
    await expect(service.getPortfolio(userActor(ayse))).rejects.toMatchObject({
      status: 500,
      code: "portfolio_not_provisioned",
    });

    expect(writes).toBe(0);
    expect(internals().store.portfolios).toHaveLength(0);
  });

  it("hata mesajı iç detay sızdırmaz", async () => {
    internals().store.portfolios = [];
    await expect(service.getPortfolio(userActor(ayse))).rejects.toMatchObject({
      message: expect.stringContaining("yöneticinizle iletişime geçin"),
    });
  });
});

describe("yönetici onarımı idempotenttir", () => {
  it("eksik portföyü tamamlar, ikinci çağrı hiçbir şey yapmaz", async () => {
    internals().store.portfolios = [];

    expect(await backend.provisionMissingDefaults()).toBe(1);
    expect(await backend.provisionMissingDefaults()).toBe(0);
    expect(internals().store.portfolios.filter((row) => row.userId === ayse.id)).toHaveLength(1);

    // Onarımdan sonra okuma çalışır ve yine yazmaz.
    const before = writes;
    const portfolio = await service.getPortfolio(userActor(ayse));
    expect(portfolio.name).toBe("Portföyüm");
    expect(writes).toBe(before);
  });

  it("mevcut portföyü olan kullanıcıya ikinci portföy açmaz", async () => {
    expect(await backend.provisionMissingDefaults()).toBe(0);
    expect(internals().store.portfolios.filter((row) => row.userId === ayse.id)).toHaveLength(1);
  });
});
