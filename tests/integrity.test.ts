import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { findNegativeHolding } from "@/domain/portfolio";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { OversellError } from "@/server/auth/backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { scopeOf, userActor } from "./actors";
import { makeInput, makeTransaction } from "./helpers";

/**
 * VERİTABANI BÜTÜNLÜĞÜ
 *
 * Aşırı satış kuralı iki yerde birden uygulanır:
 *  - Uygulama katmanı (bu testler, yerel arka uç ve saf domain fonksiyonu)
 *  - Postgres (0005_security_hardening.sql içindeki atomik RPC'ler)
 *
 * Buradaki testler kuralın eşzamanlı isteklerde de bozulmadığını doğrular.
 */

let backend: LocalAuthBackend;
let service: UserPortfolioService;
let user: UserProfile;

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new UserPortfolioService(backend);
  user = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe Kullanıcı",
    temporaryPassword: "Kuyumcu7Defter",
    role: "user",
  });
});

describe("kronolojik negatif bakiye tespiti", () => {
  it("sıralı alış-satışta negatif yoktur", () => {
    const rows = [
      makeTransaction({ id: "a", tradedAt: "2026-01-10", quantity: 10 }),
      makeTransaction({ id: "b", tradedAt: "2026-01-20", side: "sell", quantity: 4 }),
    ];
    expect(findNegativeHolding(rows)).toBeNull();
  });

  it("satış alıştan önce gelirse negatif yakalanır", () => {
    const rows = [
      makeTransaction({ id: "a", tradedAt: "2026-01-20", quantity: 10 }),
      makeTransaction({ id: "b", tradedAt: "2026-01-10", side: "sell", quantity: 4 }),
    ];
    const negative = findNegativeHolding(rows);
    expect(negative?.productId).toBe("gram-altin");
    expect(negative?.quantity).toBeLessThan(0);
  });

  it("farklı ürünler birbirini etkilemez", () => {
    const rows = [
      makeTransaction({ id: "a", productId: "gram-altin", quantity: 10 }),
      makeTransaction({
        id: "b",
        productId: "yeni-ceyrek",
        side: "sell",
        quantity: 1,
        tradedAt: "2026-01-20",
      }),
    ];
    expect(findNegativeHolding(rows)?.productId).toBe("yeni-ceyrek");
  });
});

describe("aşırı satış koruması", () => {
  it("eldeki miktardan fazlası satılamaz", async () => {
    await service.createTransaction(
      userActor(user),
      makeInput({ tradedAt: "2026-01-10", quantity: 5, unitPrice: 5000 }),
    );

    await expect(
      service.createTransaction(
        userActor(user),
        makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 6, unitPrice: 5200 }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("EŞZAMANLI iki satış birlikte eldeki miktarı aşamaz", async () => {
    await backend.createTransaction(
      scopeOf(user),
      makeInput({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
    );

    // İki satış aynı anda başlar; her biri tek başına geçerlidir (6 + 6 > 10).
    const results = await Promise.allSettled([
      backend.createTransaction(
        scopeOf(user),
        makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 6, unitPrice: 5200 }),
      ),
      backend.createTransaction(
        scopeOf(user),
        makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 6, unitPrice: 5200 }),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OversellError);

    // Kalan miktar hiçbir zaman negatife düşmez.
    const rows = await backend.listTransactions(scopeOf(user));
    expect(findNegativeHolding(rows)).toBeNull();
  });

  it("çok sayıda eşzamanlı satışta yalnızca karşılanabilir olanlar yazılır", async () => {
    await backend.createTransaction(
      scopeOf(user),
      makeInput({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
    );

    const attempts = Array.from({ length: 8 }, () =>
      backend.createTransaction(
        scopeOf(user),
        makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 3, unitPrice: 5200 }),
      ),
    );
    const results = await Promise.allSettled(attempts);
    const accepted = results.filter((result) => result.status === "fulfilled").length;

    // 10 gramdan en fazla 3 adet 3 gramlık satış yapılabilir.
    expect(accepted).toBe(3);
    expect(findNegativeHolding(await backend.listTransactions(scopeOf(user)))).toBeNull();
  });

  it("bir alışın silinmesi sonraki satışları geçersiz kılıyorsa engellenir", async () => {
    const buy = await service.createTransaction(
      userActor(user),
      makeInput({ tradedAt: "2026-01-10", quantity: 5, unitPrice: 5000 }),
    );
    await service.createTransaction(
      userActor(user),
      makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 5, unitPrice: 5200 }),
    );

    await expect(service.deleteTransaction(userActor(user), buy.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(await service.listTransactions(userActor(user))).toHaveLength(2);
  });

  it("alış miktarını satışın altına düşüren güncelleme engellenir", async () => {
    const buy = await service.createTransaction(
      userActor(user),
      makeInput({ tradedAt: "2026-01-10", quantity: 10, unitPrice: 5000 }),
    );
    await service.createTransaction(
      userActor(user),
      makeInput({ tradedAt: "2026-01-20", side: "sell", quantity: 8, unitPrice: 5200 }),
    );

    await expect(
      service.updateTransaction(
        userActor(user),
        buy.id,
        makeInput({ tradedAt: "2026-01-10", quantity: 3, unitPrice: 5000 }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("birim tutarlılığı", () => {
  it("ürünün birimi istemciden alınmaz, katalogdan gelir", async () => {
    const created = await service.createTransaction(userActor(user), {
      productId: "yeni-ceyrek",
      side: "buy",
      quantity: 2,
      // İstemci yanlış birim gönderse bile katalogdaki birim kullanılır.
      unit: "gram",
      tradedAt: "2026-01-10",
      unitPrice: 9000,
      feeAmount: 0,
      note: "",
    });
    expect(created.unit).toBe("adet");
  });

  it("arka uç uyumsuz birimi reddeder", async () => {
    await expect(
      backend.createTransaction(scopeOf(user), {
        ...makeInput({ productId: "yeni-ceyrek", quantity: 1, unitPrice: 9000 }),
        unit: "gram",
      }),
    ).rejects.toThrow(/birim/);
  });
});

describe("migration bütünlük kuralları", () => {
  const sql = readFileSync(
    join("supabase", "migrations", "0005_security_hardening.sql"),
    "utf8",
  );

  it("kullanıcı başına tek portföy kısıtı vardır", () => {
    expect(sql).toContain("add constraint portfolios_user_id_key unique (user_id)");
  });

  it("portföy sahipliği composite foreign key ile zorlanır", () => {
    expect(sql).toContain("portfolios_id_user_id_key unique (id, user_id)");
    expect(sql).toContain("transactions_portfolio_owner_fkey");
    expect(sql).toContain("foreign key (portfolio_id, user_id)");
  });

  it("birim tutarlılığı tetikleyici ile zorlanır", () => {
    expect(sql).toContain("enforce_transaction_unit");
    expect(sql).toContain("transactions_enforce_unit");
  });

  it("aşırı satış kontrolü satır kilidiyle atomiktir", () => {
    expect(sql).toContain("assert_no_oversell");
    expect(sql).toContain("lock_user_portfolio");
    expect(sql).toContain("for update");
    expect(sql).toContain("ALTIN_OVERSELL");
  });

  it("denetim kayıtları tetikleyici ile değiştirilemez", () => {
    expect(sql).toContain("admin_audit_logs_no_update");
    expect(sql).toContain("admin_audit_logs_no_delete");
    expect(sql).toContain("reject_audit_mutation");
  });

  it("migration mevcut veriyle güvenli çalışır (ön kontrol yapar)", () => {
    expect(sql).toContain("Migration durduruldu");
    expect(sql).toMatch(/birden fazla portföyü var/);
  });
});
