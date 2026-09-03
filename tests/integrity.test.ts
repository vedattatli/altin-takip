import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { findLedgerOversell, parseLedgerCommand, type LedgerAppendRequest } from "@/domain/accounting";
import { IdempotencyConflictError, OversellError } from "@/server/auth/backend";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { scopeOf, userActor } from "./actors";
import { buyCommand, sellCommand } from "./helpers";

/**
 * DEFTER BÜTÜNLÜĞÜ, EŞZAMANLILIK VE IDEMPOTENCY
 *
 * Kurallar iki yerde birden uygulanır:
 *  - Uygulama katmanı (bu testler: yerel arka uç + saf motor)
 *  - Postgres (0010_accounting_rpc.sql içindeki atomik RPC'ler; pgTAP ile doğrulanır)
 */

let backend: LocalAuthBackend;
let service: UserPortfolioService;
let user: UserProfile;

function requestOf(command: Parameters<typeof parseLedgerCommand>[0]): LedgerAppendRequest {
  const parsed = parseLedgerCommand(command);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.request;
}

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

describe("aşırı satış koruması", () => {
  it("eldeki miktardan fazlası satılamaz (servis: 400)", async () => {
    await service.appendTransaction(userActor(user), buyCommand({ occurredAt: "2026-01-10", quantity: "5" }));
    await expect(
      service.appendTransaction(userActor(user), sellCommand({ occurredAt: "2026-01-20", quantity: "6" })),
    ).rejects.toMatchObject({ status: 400, code: "oversell" });
  });

  it("ÖRNEK 7 — EŞZAMANLI iki 7 gramlık satış 10 gramı aşamaz; yalnızca biri başarılı olur", async () => {
    await backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ occurredAt: "2026-01-10", quantity: "10" })));

    const results = await Promise.allSettled([
      backend.appendLedgerEntry(scopeOf(user), requestOf(sellCommand({ occurredAt: "2026-01-20", quantity: "7" }))),
      backend.appendLedgerEntry(scopeOf(user), requestOf(sellCommand({ occurredAt: "2026-01-20", quantity: "7" }))),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OversellError);

    const ledger = await backend.listLedger(scopeOf(user));
    expect(findLedgerOversell(ledger)).toBeNull();
    const [position] = await backend.listPositions(scopeOf(user));
    expect(position!.quantity).toBe("3");
  });

  it("çok sayıda eşzamanlı satışta yalnızca karşılanabilir olanlar yazılır", async () => {
    await backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ occurredAt: "2026-01-10", quantity: "10" })));
    const attempts = Array.from({ length: 8 }, () =>
      backend.appendLedgerEntry(scopeOf(user), requestOf(sellCommand({ occurredAt: "2026-01-20", quantity: "3" }))),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(findLedgerOversell(await backend.listLedger(scopeOf(user)))).toBeNull();
  });

  it("ÖRNEK 9 — geçmiş alışın iptali sonraki satışı negatife düşürüyorsa void reddedilir; defter değişmez", async () => {
    const buy = await service.appendTransaction(userActor(user), buyCommand({ occurredAt: "2026-01-10", quantity: "5" }));
    await service.appendTransaction(userActor(user), sellCommand({ occurredAt: "2026-01-20", quantity: "5" }));

    await expect(service.voidTransaction(userActor(user), buy.entry.id, "test")).rejects.toMatchObject({
      status: 400,
      code: "oversell",
    });
    const ledger = await service.listLedger(userActor(user));
    expect(ledger).toHaveLength(2);
    expect(ledger.every((entry) => entry.status === "ACTIVE")).toBe(true);
  });

  it("alış miktarını satışın altına düşüren düzeltme reddedilir", async () => {
    const buy = await service.appendTransaction(userActor(user), buyCommand({ occurredAt: "2026-01-10", quantity: "10" }));
    await service.appendTransaction(userActor(user), sellCommand({ occurredAt: "2026-01-20", quantity: "8" }));

    await expect(
      service.replaceTransaction(userActor(user), buy.entry.id, buyCommand({ occurredAt: "2026-01-10", quantity: "3" })),
    ).rejects.toMatchObject({ status: 400 });
    const ledger = await service.listLedger(userActor(user));
    expect(ledger).toHaveLength(2);
    expect(ledger.find((entry) => entry.id === buy.entry.id)?.status).toBe("ACTIVE");
  });
});

describe("void / replacement", () => {
  it("iptal hard delete değildir; sebep ve tarih kaydedilir; pozisyon yeniden hesaplanır", async () => {
    const created = await service.appendTransaction(userActor(user), buyCommand({ quantity: "4" }));
    const result = await service.voidTransaction(userActor(user), created.entry.id, "Yanlış girdim");
    expect(result.entry.status).toBe("VOID");
    expect(result.entry.voidReason).toBe("Yanlış girdim");
    expect(result.entry.voidedAt).toBeTruthy();
    expect(result.position.quantity).toBe("0");
    expect(await service.listLedger(userActor(user))).toHaveLength(1);
  });

  it("düzeltme eski kaydı REPLACED yapar, yeni kaydı ilişkilendirir ve tek adımda tamamlanır", async () => {
    const created = await service.appendTransaction(userActor(user), buyCommand({ quantity: "2" }));
    const result = await service.replaceTransaction(userActor(user), created.entry.id, buyCommand({ quantity: "6" }));
    expect(result.voided.status).toBe("REPLACED");
    expect(result.voided.replacedByTransactionId).toBe(result.entry.id);
    expect(result.entry.replacesTransactionId).toBe(created.entry.id);
    expect(result.positions[0]!.quantity).toBe("6");

    await expect(service.voidTransaction(userActor(user), created.entry.id, "x")).rejects.toMatchObject({ status: 409 });
  });

  it("geçmiş tarihli işlem eklenince sonraki pozisyon yeniden hesaplanır", async () => {
    await service.appendTransaction(userActor(user), buyCommand({ occurredAt: "2026-02-01", quantity: "10", unitPrice: "5000" }));
    await service.appendTransaction(userActor(user), sellCommand({ occurredAt: "2026-02-10", quantity: "4", unitPrice: "6000" }));
    // Geçmişe dönük ucuz alış ortalamayı ve gerçekleşmiş K/Z'yi değiştirir.
    const result = await service.appendTransaction(
      userActor(user),
      buyCommand({ occurredAt: "2026-01-15", quantity: "10", unitPrice: "3000" }),
    );
    // 20 gram, 80.000 TL, ortalama 4.000; satış 4 gram: çıkarılan 16.000, gelir 24.000 -> 8.000
    expect(result.position.quantity).toBe("16");
    expect(result.position.averageCost).toBe("4000");
    expect(result.position.realizedPnl).toBe("8000");
  });
});

describe("ÖRNEK 8 — idempotency", () => {
  it("aynı istek kimliğiyle aynı BUY iki kez gönderilince tek işlem oluşur ve ikinci yanıt replay döner", async () => {
    const command = buyCommand({ quantity: "3", clientRequestId: "req-mobile-retry-01" });
    const first = await service.appendTransaction(userActor(user), command);
    const second = await service.appendTransaction(userActor(user), command);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.position.quantity).toBe("3");
    expect(await service.listLedger(userActor(user))).toHaveLength(1);
  });

  it("aynı istek kimliği farklı içerikle gelirse conflict (409) döner", async () => {
    await service.appendTransaction(userActor(user), buyCommand({ quantity: "3", clientRequestId: "req-mobile-retry-02" }));
    await expect(
      service.appendTransaction(userActor(user), buyCommand({ quantity: "4", clientRequestId: "req-mobile-retry-02" })),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await expect(
      backend.appendLedgerEntry(scopeOf(user), requestOf(buyCommand({ quantity: "9", clientRequestId: "req-mobile-retry-02" }))),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("idempotency anahtarı kullanıcı kapsamındadır; başka kullanıcı aynı anahtarı kullanabilir", async () => {
    const other = await backend.createUser({
      username: "mehmet",
      displayName: "Mehmet",
      temporaryPassword: "Kuyumcu7Defter",
      role: "user",
    });
    await service.appendTransaction(userActor(user), buyCommand({ quantity: "1", clientRequestId: "req-shared-key-0001" }));
    const result = await service.appendTransaction(userActor(other), buyCommand({ quantity: "2", clientRequestId: "req-shared-key-0001" }));
    expect(result.replayed).toBe(false);
    expect(result.position.quantity).toBe("2");
  });
});

describe("birim tutarlılığı", () => {
  it("ürünün birimi istemciden alınmaz, katalogdan gelir", async () => {
    const created = await service.appendTransaction(userActor(user), {
      ...buyCommand({ productId: "yeni-ceyrek", quantity: "2", unitPrice: "9000" }),
      unit: "gram",
    });
    expect(created.entry.unit).toBe("adet");
  });

  it("arka uç uyumsuz birimi reddeder", async () => {
    await expect(
      backend.appendLedgerEntry(scopeOf(user), {
        ...requestOf(buyCommand({ productId: "yeni-ceyrek", quantity: "1", unitPrice: "9000" })),
        unit: "gram",
      }),
    ).rejects.toThrow(/birim/);
  });
});

describe("migration bütünlük kuralları", () => {
  const hardening = readFileSync(join("supabase", "migrations", "0005_security_hardening.sql"), "utf8");
  const schema = readFileSync(join("supabase", "migrations", "0009_portfolio_accounting.sql"), "utf8");
  const rpc = readFileSync(join("supabase", "migrations", "0010_accounting_rpc.sql"), "utf8");

  it("kullanıcı başına tek portföy ve composite foreign key korunur", () => {
    expect(hardening).toContain("portfolios_user_id_key unique (user_id)");
    expect(hardening).toContain("transactions_portfolio_owner_fkey");
  });

  it("defter kaydı hard delete edilemez ve finansal alanları değiştirilemez", () => {
    expect(schema).toContain("create trigger transactions_ledger_guard_delete");
    expect(schema).toContain("create trigger transactions_ledger_guard_update");
    expect(schema).toContain("Defter kaydı silinemez");
  });

  it("idempotency anahtarı kullanıcı kapsamında benzersizdir", () => {
    expect(schema).toContain("transactions_client_request_idx");
    expect(schema).toContain("on public.transactions (user_id, client_request_id)");
    expect(rpc).toContain("ALTIN_IDEMPOTENCY_CONFLICT");
  });

  it("her mutation portföy satırını ve ürün düzeyinde advisory lock alır; pozisyon aynı işlemde yeniden oluşturulur", () => {
    for (const fn of ["ledger_append", "ledger_void", "ledger_replace"]) {
      const body = rpc.slice(rpc.indexOf(`create or replace function public.${fn}(`));
      const scoped = body.slice(0, body.indexOf("$$;\n", body.indexOf("as $$")));
      expect(scoped, fn).toContain("lock_user_portfolio");
      expect(scoped, fn).toContain("pg_advisory_xact_lock");
      expect(scoped, fn).toContain("ledger_rebuild_position");
    }
    expect(rpc).toContain("raise exception 'ALTIN_OVERSELL");
  });

  it("türetilmiş pozisyon tablosuna service_role bile doğrudan yazamaz", () => {
    expect(schema).toContain("revoke all on table public.portfolio_positions from service_role");
    expect(schema).toContain("grant select on table public.portfolio_positions to service_role");
    expect(schema).not.toMatch(/grant [^\n]*(insert|update|delete)[^\n]*portfolio_positions/);
  });

  it("fiyat anlık görüntüsü değiştirilemez", () => {
    expect(schema).toContain("create trigger price_snapshots_no_update");
    expect(schema).toContain("create trigger price_snapshots_no_delete");
  });

  it("denetim kayıtları tetikleyici ile değiştirilemez", () => {
    expect(hardening).toContain("reject_audit_mutation");
  });

  it("denetim eylemi listesi TypeScript ile SQL arasında birebir aynıdır", () => {
    // Listeler ayrışırsa yeni bir eylem çalışma zamanında check kısıtına takılır.
    const types = readFileSync(join(process.cwd(), "src", "auth", "types.ts"), "utf8");
    const block = types.slice(
      types.indexOf("export type AdminAction"),
      types.indexOf("export interface AdminAuditLog"),
    );
    const fromTypes = [...block.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((match) => match[1]).sort();

    // Kısıt birden çok migration'da yeniden tanımlanabilir; SON tanım geçerlidir.
    const migrationsDir = join(process.cwd(), "supabase", "migrations");
    const withConstraint = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .filter((file) => readFileSync(join(migrationsDir, file), "utf8").includes("admin_audit_logs_action_check check"));
    expect(withConstraint.length).toBeGreaterThan(0);
    const latest = readFileSync(join(migrationsDir, withConstraint[withConstraint.length - 1]!), "utf8");
    const constraint = latest.slice(latest.lastIndexOf("admin_audit_logs_action_check check"));
    const fromSql = [...constraint.slice(0, constraint.indexOf(");")).matchAll(/'([a-z_]+\.[a-z_]+)'/g)]
      .map((match) => match[1])
      .sort();

    expect(fromTypes.length).toBeGreaterThan(0);
    expect(fromSql).toEqual(fromTypes);
  });
});
