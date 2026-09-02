import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hashRateLimitKey } from "@/server/rate-limit/key";
import { MemoryLoginRateLimiter } from "@/server/rate-limit/memory";
import { PostgresLoginRateLimiter } from "@/server/rate-limit/postgres";
import { DEFAULT_RATE_LIMIT_SETTINGS } from "@/server/rate-limit/types";

/**
 * DAĞITIK HIZ SINIRLAYICI
 *
 * Üretimde sayaç Postgres'te paylaşılır; süreç belleği kullanılmaz.
 * Ham IP ve kullanıcı adı saklanmaz, peppered HMAC özeti tutulur.
 */

const SETTINGS = { maxAttempts: 3, windowMs: 60_000, baseLockMs: 30_000, maxLockMs: 120_000 };

describe("anahtar gizleme", () => {
  it("ham anahtar özet içinde görünmez", () => {
    const raw = "203.0.113.9|ayse";
    const hashed = hashRateLimitKey(raw, "pepper-degeri");

    expect(hashed).not.toContain("203.0.113.9");
    expect(hashed).not.toContain("ayse");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("aynı anahtar aynı özeti verir", () => {
    expect(hashRateLimitKey("a|b", "pepper")).toBe(hashRateLimitKey("a|b", "pepper"));
  });

  it("pepper değişince özet değişir", () => {
    expect(hashRateLimitKey("a|b", "pepper1")).not.toBe(hashRateLimitKey("a|b", "pepper2"));
  });

  it("pepper yoksa hata verir", () => {
    expect(() => hashRateLimitKey("a|b", "")).toThrow(/RATE_LIMIT_PEPPER/);
  });
});

describe("bellek sınırlayıcı (geliştirme/test)", () => {
  it("sözleşmeyi uygular", async () => {
    let now = 0;
    const limiter = new MemoryLoginRateLimiter("pepper", SETTINGS, () => now);

    expect((await limiter.check("a")).allowed).toBe(true);
    await limiter.recordFailure("a");
    await limiter.recordFailure("a");
    const third = await limiter.recordFailure("a");

    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBe(30_000);
    expect((await limiter.check("a")).allowed).toBe(false);

    now += 30_001;
    expect((await limiter.check("a")).allowed).toBe(true);
  });

  it("başarılı girişte sayaç sıfırlanır", async () => {
    const limiter = new MemoryLoginRateLimiter("pepper", SETTINGS, () => 0);
    await limiter.recordFailure("a");
    await limiter.recordFailure("a");
    await limiter.reset("a");
    expect((await limiter.check("a")).remaining).toBe(3);
  });

  it("farklı anahtarlar birbirini etkilemez", async () => {
    const limiter = new MemoryLoginRateLimiter("pepper", SETTINGS, () => 0);
    for (let index = 0; index < 3; index += 1) await limiter.recordFailure("a");
    expect((await limiter.check("a")).allowed).toBe(false);
    expect((await limiter.check("b")).allowed).toBe(true);
  });

  it("kimliği memory olarak bildirir", () => {
    expect(new MemoryLoginRateLimiter("pepper").id).toBe("memory");
  });
});

describe("Postgres sınırlayıcı", () => {
  function fakeClient(response: { data?: unknown; error?: { message: string } }) {
    const calls: { fn: string; params: Record<string, unknown> }[] = [];
    return {
      calls,
      client: {
        rpc: async (fn: string, params: Record<string, unknown>) => {
          calls.push({ fn, params });
          return response;
        },
      },
    };
  }

  it("kararı RPC'den okur", async () => {
    const { client, calls } = fakeClient({
      data: [{ allowed: false, remaining: 0, retry_after_ms: 60_000 }],
    });
    const limiter = new PostgresLoginRateLimiter(
      client as never,
      "pepper",
      DEFAULT_RATE_LIMIT_SETTINGS,
    );

    const decision = await limiter.recordFailure("203.0.113.9|ayse");
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
    expect(calls[0].fn).toBe("login_rate_limit_record_failure");
  });

  it("RPC'ye ham anahtar göndermez", async () => {
    const { client, calls } = fakeClient({ data: [{ allowed: true, remaining: 4 }] });
    const limiter = new PostgresLoginRateLimiter(client as never, "pepper");

    await limiter.check("203.0.113.9|ayse");
    const params = JSON.stringify(calls[0].params);
    expect(params).not.toContain("203.0.113.9");
    expect(params).not.toContain("ayse");
    expect(calls[0].params.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("RPC hatasında AÇIK KALMAZ, hata fırlatır (fail closed)", async () => {
    const { client } = fakeClient({ error: { message: "bağlantı yok" } });
    const limiter = new PostgresLoginRateLimiter(client as never, "pepper");

    await expect(limiter.check("a|b")).rejects.toThrow(/Hız sınırlayıcı okunamadı/);
    await expect(limiter.recordFailure("a|b")).rejects.toThrow(/güncellenemedi/);
    await expect(limiter.reset("a|b")).rejects.toThrow(/sıfırlanamadı/);
  });

  it("kimliği postgres olarak bildirir", () => {
    expect(new PostgresLoginRateLimiter({} as never, "pepper").id).toBe("postgres");
  });
});

describe("SQL tarafı", () => {
  const sql = readFileSync(
    join("supabase", "migrations", "0005_security_hardening.sql"),
    "utf8",
  );

  it("paylaşımlı sayaç tablosu vardır ve ham veri içermez", () => {
    expect(sql).toContain("create table if not exists public.login_rate_limits");
    expect(sql).toContain("key_hash text primary key");
    expect(sql).not.toMatch(/login_rate_limits[\s\S]{0,400}ip_address/);
  });

  it("sayaç güncellemesi satır kilidiyle atomiktir", () => {
    const fn = sql.slice(sql.indexOf("login_rate_limit_record_failure"));
    expect(fn).toContain("for update");
  });

  it("otomatik temizlik fonksiyonu vardır", () => {
    expect(sql).toContain("login_rate_limit_cleanup");
  });

  it("tabloya istemci erişimi yoktur", () => {
    expect(sql).toContain("alter table public.login_rate_limits enable row level security");
    expect(sql).toContain("alter table public.login_rate_limits force row level security");
  });
});

describe("üretimde bellek sınırlayıcısına sessizce düşülmez", () => {
  const source = readFileSync(join("src", "server", "rate-limit", "index.ts"), "utf8");

  it("üretimde Supabase yapılandırması zorunludur", () => {
    expect(source).toContain("serverEnv.isProduction");
    expect(source).toContain("misconfigured");
    expect(source).toMatch(/Üretimde paylaşımlı hız sınırlayıcı/);
  });

  it("üretimde pepper zorunludur", () => {
    expect(source).toMatch(/RATE_LIMIT_PEPPER tanımlı değil/);
  });

  it("üretim dalında bellek sınırlayıcısı oluşturulmaz", () => {
    const productionBranch = source.slice(
      source.indexOf("if (serverEnv.isProduction && !testEscapeHatch)"),
      source.indexOf("// Geliştirme/test"),
    );
    expect(productionBranch).not.toContain("MemoryLoginRateLimiter");
    expect(productionBranch).toContain("PostgresLoginRateLimiter");
  });

  it("kaçış kapısı yalnızca açık test belirteciyle çalışır", () => {
    expect(source).toContain("serverEnv.allowLocalBackendInProduction");
    expect(source).toMatch(/AUTH_ALLOW_LOCAL_BACKEND/);
  });
});
