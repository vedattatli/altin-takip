import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * VERİTABANI YETKİ SINIRI — statik denetimler.
 *
 * Gerçek yetki davranışı pgTAP ile doğrulanır (supabase/tests/rls.test.sql,
 * `npm run test:db`). Buradaki testler migration metninin, bakım dosyasının
 * ve paketleme araçlarının beklenen kuralları taşıdığını denetler; böylece
 * pgTAP çalıştırılamayan ortamda bile geriye gidiş fark edilir.
 */

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

const MIGRATION = read("supabase", "migrations", "0006_database_boundary.sql");
const SESSIONS_MIGRATION = read("supabase", "migrations", "0007_persistent_sessions.sql");
const CRON = read("supabase", "setup", "maintenance-cron.sql");

const TOP_LEVEL_RPCS = [
  "public.purge_expired_sessions()",
  "public.create_transaction_checked(uuid, text, text, numeric, text, date, numeric, numeric, text)",
  "public.update_transaction_checked(uuid, uuid, text, text, numeric, text, date, numeric, numeric, text)",
  "public.delete_transaction_checked(uuid, uuid)",
  "public.login_rate_limit_check(text, integer, integer, integer, integer)",
  "public.login_rate_limit_record_failure(text, integer, integer, integer, integer)",
  "public.login_rate_limit_reset(text)",
  "public.login_rate_limit_cleanup(integer)",
];

const INTERNAL_HELPERS = [
  "public.assert_no_oversell(uuid, text)",
  "public.lock_user_portfolio(uuid)",
  "public.reject_audit_mutation()",
  "public.enforce_transaction_unit()",
  "public.touch_updated_at()",
  "public.prevent_profile_privilege_escalation()",
];

const DROPPED_POLICIES = [
  "portfolios_insert_own",
  "portfolios_update_own",
  "portfolios_delete_own",
  "transactions_insert_own",
  "transactions_update_own",
  "transactions_delete_own",
  "user_preferences_all_own",
  "profiles_update_self",
];

describe("0006 — fonksiyon yetkileri", () => {
  it("üst seviye BFF RPC'leri tam imzayla listelenir ve yalnızca service_role'e verilir", () => {
    for (const fn of TOP_LEVEL_RPCS) expect(MIGRATION, fn).toContain(`'${fn}'`);
    expect(MIGRATION).toContain("revoke all on function %s from public");
    expect(MIGRATION).toContain("revoke all on function %s from anon");
    expect(MIGRATION).toContain("revoke all on function %s from authenticated");
    expect(MIGRATION).toContain("grant execute on function %s to service_role");
  });

  it("dahili yardımcılar hiçbir role verilmez", () => {
    for (const fn of INTERNAL_HELPERS) expect(MIGRATION, fn).toContain(`'${fn}'`);
    // Yardımcı listesinden sonra service_role'e grant yoktur.
    const helperBlock = MIGRATION.slice(
      MIGRATION.indexOf("1b."),
      MIGRATION.indexOf("1c."),
    );
    expect(helperBlock).not.toMatch(/grant execute/);
    expect(helperBlock).toContain("revoke all on function %s from service_role");
  });

  it("RLS yardımcıları authenticated için korunur", () => {
    expect(MIGRATION).toContain("grant execute on function public.current_role_name() to authenticated");
    expect(MIGRATION).toContain("grant execute on function public.is_admin() to authenticated");
  });

  it("varsayılan fonksiyon yetkileri korumalı biçimde kapatılır", () => {
    expect(MIGRATION).toContain("pg_has_role(current_user, 'postgres', 'MEMBER')");
    // PostgreSQL yeni fonksiyonlara örtük PUBLIC EXECUTE verir; o da kapatılmalıdır.
    expect(MIGRATION).toContain("revoke execute on functions from public;");
    expect(MIGRATION).toContain("revoke execute on functions from anon, authenticated;");
  });

  it("provisioning fonksiyonlarından yalnızca onarım service_role'e açıktır", () => {
    expect(MIGRATION).toContain(
      "grant execute on function public.provision_missing_defaults() to service_role",
    );
    expect(MIGRATION).not.toMatch(/grant execute on function public\.provision_user_defaults\(uuid\)/);
    expect(MIGRATION).not.toMatch(/grant execute on function public\.lock_user_portfolio/);
  });
});

describe("0006 — tablo yetkileri (Data API doğrudan yazma yüzeyi)", () => {
  it("kişisel/finansal tablolarda anon hiçbir şey, authenticated yalnızca SELECT alır", () => {
    for (const table of ["profiles", "portfolios", "transactions", "user_preferences"]) {
      expect(MIGRATION).toContain(`'public.${table}'`);
    }
    expect(MIGRATION).toContain("revoke all on table %s from anon");
    expect(MIGRATION).toContain("grant select on table %s to authenticated");
    expect(MIGRATION).not.toMatch(/grant [^\n]*to anon/);
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete)[^\n]*to authenticated/);
  });

  it("app_sessions ve login_rate_limits hiçbir istemci rolüne açık değildir", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("2b."), MIGRATION.indexOf("2c."));
    expect(block).toContain("'public.app_sessions', 'public.login_rate_limits'");
    expect(block).not.toMatch(/to authenticated/);
    expect(block).not.toMatch(/to anon/);
    expect(block).toContain("grant select, insert, update, delete on table %s to service_role");
  });

  it("denetim kaydı: authenticated SELECT, service_role SELECT+INSERT; UPDATE/DELETE kimseye", () => {
    expect(MIGRATION).toContain("grant select on table public.admin_audit_logs to authenticated");
    expect(MIGRATION).toContain("grant select, insert on table public.admin_audit_logs to service_role");
    expect(MIGRATION).not.toMatch(/grant [^\n]*(update|delete)[^\n]*admin_audit_logs/);
  });
});

describe("0006 — doğrudan yazma politikaları", () => {
  it("0002'deki mutation politikaları kaldırılır", () => {
    for (const policy of DROPPED_POLICIES) {
      expect(MIGRATION).toContain(`drop policy if exists ${policy}`);
    }
  });

  it("SELECT politikaları korunur, yalnızca tercihler için salt okunur politika eklenir", () => {
    expect(MIGRATION).toContain("create policy user_preferences_select_own");
    expect(MIGRATION).not.toMatch(/create policy \w+ on public\.\w+\s+for (insert|update|delete)/);
    expect(MIGRATION).not.toMatch(/create policy \w+ on public\.\w+\s+for all/);
  });

  it("eski migration dosyaları değiştirilmemiştir (yalnızca yeni dosya eklenir)", () => {
    const rls = read("supabase", "migrations", "0002_rls.sql");
    for (const policy of DROPPED_POLICIES) expect(rls).toContain(`create policy ${policy}`);
  });
});

describe("0006 — provisioning", () => {
  it("profil eklenince tetikleyici varsayılanları hazırlar; GET yolu yazmaz", () => {
    expect(MIGRATION).toContain("create trigger profiles_provision_defaults");
    expect(MIGRATION).toContain("after insert on public.profiles");
    expect(MIGRATION).toContain("on conflict (user_id) do nothing");
  });

  it("lock_user_portfolio artık portföy OLUŞTURMAZ", () => {
    const fn = MIGRATION.slice(MIGRATION.lastIndexOf("create or replace function public.lock_user_portfolio"));
    expect(fn).toContain("ALTIN_PORTFOLIO_NOT_PROVISIONED");
    expect(fn).not.toMatch(/insert into public\.portfolios/);
  });
});

describe("0007 — kalıcı oturum şeması", () => {
  it("yeni sütunlar eklenir ve eski cihaz modu kısıtları kaldırılır", () => {
    for (const column of ["renewed_at", "rotated_at", "previous_token_hash", "previous_token_valid_until", "device_label"]) {
      expect(SESSIONS_MIGRATION).toContain(`add column if not exists ${column}`);
    }
    expect(SESSIONS_MIGRATION).toContain("drop constraint if exists app_sessions_shared_needs_idle");
    expect(SESSIONS_MIGRATION).toContain("drop constraint if exists app_sessions_device_mode_check");
  });

  it("temizlik fonksiyonu hareketsizlik alanına bakmaz ve yalnızca service_role'e açıktır", () => {
    const fn = SESSIONS_MIGRATION.slice(SESSIONS_MIGRATION.indexOf("create or replace function public.purge_expired_sessions"));
    expect(fn).not.toContain("idle_expires_at");
    expect(fn).toContain("grant execute on function public.purge_expired_sessions() to service_role");
  });
});

describe("bakım görevleri (pg_cron)", () => {
  it("iki görevi idempotent kurar ve pg_cron yoksa hata vermez", () => {
    expect(CRON).toContain("altin_purge_expired_sessions");
    expect(CRON).toContain("altin_login_rate_limit_cleanup");
    expect(CRON).toContain("cron.unschedule(jobid)");
    expect(CRON).toContain("from pg_extension where extname = 'pg_cron'");
    expect(CRON).toContain("public.purge_expired_sessions()");
    expect(CRON).toContain("public.login_rate_limit_cleanup(60)");
  });

  it("görevlerin çalıştığını iddia etmez", () => {
    expect(CRON).toMatch(/İDDİA ETMEZ/);
  });
});

describe("istemci paketi taraması", () => {
  it("yeni sb_secret_ anahtar biçimini ve SUPABASE_SECRET_KEY adını arar", () => {
    const checker = read("scripts", "check-client-bundle.mjs");
    expect(checker).toContain('"SUPABASE_SECRET_KEY"');
    expect(checker).toContain('"sb_secret_"');
    expect(checker).toContain('"SUPABASE_SERVICE_ROLE_KEY"');
  });
});

interface PackageModule {
  buildZip(entries: { name: string; data: Buffer }[]): Buffer;
  readZip(archive: Buffer): { name: string; data: Buffer; crc: number }[];
  crc32(buffer: Buffer): number;
  isExcludedFile(name: string): boolean;
  EXCLUDED_DIRS: Set<string>;
  FORBIDDEN_PATH_PATTERNS: RegExp[];
  SECRET_PATTERNS: { label: string; test: (content: string) => boolean }[];
  REQUIRED: string[];
}

async function loadPackager(): Promise<PackageModule> {
  const url = pathToFileURL(join(process.cwd(), "scripts", "package-source.mjs")).href;
  return (await import(/* @vite-ignore */ url)) as PackageModule;
}

describe("kaynak paketi (ZIP)", () => {
  it("girişler '/' ayraçlı yazılır, yeniden açılır ve CRC'leri eşleşir", async () => {
    const packager = await loadPackager();
    const entries = [
      { name: "Altin-Takip-Source/package.json", data: Buffer.from('{"name":"x"}') },
      { name: "Altin-Takip-Source/src/server/auth/actor.ts", data: Buffer.from("export const a = 1;\n".repeat(50)) },
      { name: "Altin-Takip-Source/docs/SECURITY.md", data: Buffer.from("# Güvenlik\n") },
    ];
    const archive = packager.buildZip(entries);
    const reopened = packager.readZip(archive);

    expect(reopened.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    for (const entry of reopened) {
      expect(entry.name).not.toContain("\\");
      const source = entries.find((candidate) => candidate.name === entry.name)!;
      expect(entry.data.equals(source.data)).toBe(true);
      expect(entry.crc).toBe(packager.crc32(source.data));
    }
  });

  it("ters bölü içeren giriş adı reddedilir", async () => {
    const packager = await loadPackager();
    expect(() =>
      packager.buildZip([{ name: "Altin-Takip-Source\\src\\a.ts", data: Buffer.from("x") }]),
    ).toThrow(/Geçersiz ZIP giriş adı/);
  });

  it("bozulan arşivde CRC uyuşmazlığı yakalanır", async () => {
    const packager = await loadPackager();
    // Sıkıştırılamayan (rastgele) içerik STORE yöntemiyle yazılır; bir veri
    // baytı bozulunca açma hatası değil doğrudan CRC uyuşmazlığı oluşur.
    const random = randomBytes(2048);
    const archive = packager.buildZip([{ name: "Altin-Takip-Source/a.bin", data: random }]);

    const corrupted = Buffer.from(archive);
    const dataStart = 30 + "Altin-Takip-Source/a.bin".length;
    corrupted[dataStart] = corrupted[dataStart]! ^ 0xff;
    expect(() => packager.readZip(corrupted)).toThrow(/CRC uyuşmazlığı/);

    // Sıkıştırılmış giriş bozulursa da açma aşamasında yakalanır.
    const deflated = packager.buildZip([
      { name: "Altin-Takip-Source/b.txt", data: Buffer.from("merhaba dünya ".repeat(50)) },
    ]);
    const corruptedDeflate = Buffer.from(deflated);
    const deflateStart = 30 + "Altin-Takip-Source/b.txt".length + 2;
    corruptedDeflate[deflateStart] = corruptedDeflate[deflateStart]! ^ 0xff;
    expect(() => packager.readZip(corruptedDeflate)).toThrow();
  });

  it("gizli ve derleme dosyaları pakete girmez", async () => {
    const packager = await loadPackager();
    for (const dir of [".git", "node_modules", ".next", ".data", "test-results", "dist"]) {
      expect(packager.EXCLUDED_DIRS.has(dir), dir).toBe(true);
    }
    expect(packager.isExcludedFile(".env.local")).toBe(true);
    expect(packager.isExcludedFile(".env")).toBe(true);
    expect(packager.isExcludedFile(".env.production")).toBe(true);
    expect(packager.isExcludedFile("debug.log")).toBe(true);
    expect(packager.isExcludedFile("tsconfig.tsbuildinfo")).toBe(true);
    expect(packager.isExcludedFile(".env.example")).toBe(false);
    expect(packager.FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test("app/.env.local"))).toBe(true);
    expect(packager.FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(".env.example"))).toBe(false);
  });

  it("secret taraması yeni anahtar biçimini tanır, boş örnek satırını tanımaz", async () => {
    const packager = await loadPackager();
    const detects = (content: string) => packager.SECRET_PATTERNS.some((pattern) => pattern.test(content));
    // Örnek anahtar parçalardan üretilir; kaynak kodda tarayıcıyı tetikleyen düz metin bulunmaz.
    const sample = ["sb", "secret", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
    expect(detects(`SUPABASE_SECRET_KEY=${sample}`)).toBe(true);
    expect(detects(`const k = '${sample}';`)).toBe(true);
    expect(detects("SUPABASE_SECRET_KEY=\nSUPABASE_SERVICE_ROLE_KEY=\n")).toBe(false);
    expect(detects("# SUPABASE_SECRET_KEY tercih edilir")).toBe(false);
  });

  it("secret taraması fiyat sağlayıcı ve MFA anahtarlarını da yakalar", async () => {
    const packager = await loadPackager();
    const detects = (content: string) => packager.SECRET_PATTERNS.some((pattern) => pattern.test(content));
    expect(detects("PRICE_CRON_SECRET=degerVar")).toBe(true);
    expect(detects("AUTH_MFA_ENCRYPTION_KEY=degerVar")).toBe(true);
    expect(detects("SARRAFPRO_API_KEY=degerVar")).toBe(true);
    expect(detects("ALTINAPI_API_KEY=degerVar")).toBe(true);
    expect(detects("HASFIYAT_LICENSE_REFERENCE=SOZ-2026-1")).toBe(true);
    expect(detects("SUPABASE_STAGING_JWT_SECRET=degerVar")).toBe(true);
    // Boş örnek satırları ve düz metin anlatım tetiklemez.
    const emptyLines = ["PRICE_CRON_SECRET=", "AUTH_MFA_ENCRYPTION_KEY=", "SARRAFPRO_API_KEY=", ""].join(
      String.fromCharCode(10),
    );
    expect(detects(emptyLines)).toBe(false);
    expect(detects('curl -H "X-Cron-Secret: <PRICE_CRON_SECRET>"')).toBe(false);
  });

  it("zorunlu dosya listesi yeni migration ve bakım dosyasını içerir", async () => {
    const packager = await loadPackager();
    expect(packager.REQUIRED).toContain("supabase/migrations/0006_database_boundary.sql");
    expect(packager.REQUIRED).toContain("supabase/setup/maintenance-cron.sql");
    expect(packager.REQUIRED).toContain("supabase/migrations/0013_price_providers.sql");
    expect(packager.REQUIRED).toContain("supabase/migrations/0014_price_rpc.sql");
    expect(packager.REQUIRED).toContain("supabase/migrations/0015_admin_mfa.sql");
  });
});
