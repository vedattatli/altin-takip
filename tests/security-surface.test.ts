import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Kaynak kod yüzey denetimleri.
 *
 * Bu testler kod tabanının ürün kurallarından sapmasını erken yakalar:
 * herkese açık kayıt ucu, e-posta OTP / sihirli bağlantı arayüzü veya
 * istemciye sızan service_role anahtarı gibi.
 */

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

const SOURCE_FILES = walk("src").filter((file) => /\.(ts|tsx)$/.test(file));
const ROUTE_FILES = SOURCE_FILES.filter((file) => file.includes(`${sep}app${sep}api${sep}`));

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Yorum satırlarını ayıklar; denetimler yalnızca çalışan koda bakar. */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("herkese açık kayıt yoktur", () => {
  it("kayıt / signup uç noktası bulunmaz", () => {
    const suspicious = ROUTE_FILES.filter((file) =>
      /(register|signup|sign-up|kayit|kayıt)/i.test(relative("src", file)),
    );
    expect(suspicious).toEqual([]);
  });

  it("kayıt sayfası bulunmaz", () => {
    const pages = SOURCE_FILES.filter(
      (file) =>
        file.includes(`${sep}app${sep}`) &&
        /(register|signup|sign-up|kayit-ol|kayitol)/i.test(relative("src", file)),
    );
    expect(pages).toEqual([]);
  });

  it("giriş ekranında kayıt bağlantısı yoktur", () => {
    const login = readCode(join("src", "app", "giris", "page.tsx"));
    const form = readCode(join("src", "app", "giris", "login-form.tsx"));
    expect(`${login}${form}`).not.toMatch(/Kayıt Ol|Hesap oluştur|Üye ol/i);
  });
});

describe("e-posta OTP ve sihirli bağlantı arayüzü yoktur", () => {
  it("Supabase OTP / magic link çağrıları kullanılmaz", () => {
    const offenders = SOURCE_FILES.filter((file) =>
      /(signInWithOtp|signInWithOAuth|magiclink|magic-link|verifyOtp|resetPasswordForEmail)/i.test(
        read(file),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("giriş formunda yalnızca kullanıcı adı ve parola alanı vardır", () => {
    const form = readCode(join("src", "app", "giris", "login-form.tsx"));

    expect(form).toContain('id="username"');
    expect(form).toContain('id="password"');
    expect(form).not.toMatch(/type="email"/);
    expect(form).not.toMatch(/type="tel"/);
    expect(form).not.toMatch(/telefon|e-posta|eposta|OTP|doğrulama kodu/i);
  });

  it("giriş ekranında demo modu düğmesi bulunmaz", () => {
    const login = readCode(join("src", "app", "giris", "page.tsx"));
    const form = readCode(join("src", "app", "giris", "login-form.tsx"));
    expect(`${login}${form}`).not.toMatch(/demo/i);
  });
});

describe("service_role anahtarı istemciye sızmaz", () => {
  const SERVICE_ROLE = "SUPABASE_SERVICE_ROLE_KEY";

  it("anahtar NEXT_PUBLIC_ öneki ile hiçbir yerde kullanılmaz", () => {
    for (const file of SOURCE_FILES) {
      expect(read(file), file).not.toMatch(/NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
    }
  });

  it("anahtara yalnızca sunucuya özel modüller erişir", () => {
    const referencing = SOURCE_FILES.filter((file) => read(file).includes(SERVICE_ROLE));
    expect(referencing.length).toBeGreaterThan(0);

    for (const file of referencing) {
      const source = read(file);
      const isServerModule = file.includes(`${sep}server${sep}`);
      expect(isServerModule, `${file} sunucu klasöründe olmalı`).toBe(true);
      expect(source, `${file} "server-only" işaretli olmalı`).toMatch(/import "server-only"/);
      expect(source, `${file} istemci bileşeni olamaz`).not.toMatch(/^"use client"/m);
    }
  });

  it("istemci bileşenleri sunucu modüllerini içe aktarmaz", () => {
    const clientFiles = SOURCE_FILES.filter((file) => /^"use client"/m.test(read(file)));
    expect(clientFiles.length).toBeGreaterThan(0);

    for (const file of clientFiles) {
      const source = read(file);
      // Tür içe aktarımları derleme sırasında silinir; yalnızca çalışma zamanı
      // içe aktarımları sorun oluşturur.
      const runtimeServerImports = source
        .split("\n")
        .filter((line) => /from "@\/server\//.test(line))
        .filter((line) => !/^\s*import type /.test(line));
      expect(runtimeServerImports, `${file}`).toEqual([]);
    }
  });

  it("Supabase istemcisi yalnızca sunucu tarafında oluşturulur", () => {
    const offenders = SOURCE_FILES.filter(
      (file) => read(file).includes("@supabase/supabase-js") && !file.includes(`${sep}server${sep}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("yönetim uçları korunur", () => {
  const adminRoutes = ROUTE_FILES.filter((file) => file.includes(`${sep}admin${sep}`));

  it("her yönetim ucu requireCurrentAdmin çağırır", () => {
    expect(adminRoutes.length).toBeGreaterThan(0);
    for (const file of adminRoutes) {
      expect(read(file), file).toContain("requireCurrentAdmin");
    }
  });

  it("kullanıcı verisi uçları oturum zorunlu kılar", () => {
    const userRoutes = ROUTE_FILES.filter(
      (file) =>
        !file.includes(`${sep}admin${sep}`) &&
        (file.includes(`${sep}transactions`) || file.includes(`${sep}portfolio`)),
    );
    expect(userRoutes.length).toBeGreaterThan(0);
    for (const file of userRoutes) {
      expect(read(file), file).toContain("requireCurrentUser");
    }
  });

  it("hiçbir uç rol alanını istemciden kabul etmez", () => {
    for (const file of ROUTE_FILES) {
      expect(read(file), file).not.toMatch(/body\.role/);
    }
  });
});

describe("parola custody'si uygulamada tutulmaz", () => {
  it("Supabase arka ucu parola hash'i yazmaz", () => {
    const supabaseBackend = read(join("src", "server", "auth", "supabase-backend.ts"));
    expect(supabaseBackend).not.toMatch(/password_hash|passwordHash|bcrypt|argon2/);
  });

  it("SQL şemasında parola sütunu yoktur", () => {
    const schema = readFileSync(join("supabase", "migrations", "0001_init.sql"), "utf8");
    expect(schema).not.toMatch(/password_hash|password_digest|\bpassword\s+text/i);
  });

  it("yerel geliştirme arka ucu üretimde kullanılamaz", () => {
    const local = read(join("src", "server", "auth", "local-backend.ts"));
    expect(local).toMatch(/NODE_ENV === "production"/);
    expect(local).toMatch(/üretim ortamında kullanılamaz/);
  });
});

describe("RLS politikaları tanımlıdır", () => {
  const rls = readFileSync(join("supabase", "migrations", "0002_rls.sql"), "utf8");

  it("kullanıcı verisi tablolarında RLS açıktır", () => {
    for (const table of [
      "profiles",
      "portfolios",
      "transactions",
      "user_preferences",
      "admin_audit_logs",
      "app_sessions",
    ]) {
      expect(rls).toContain(`alter table public.${table} enable row level security`);
      expect(rls).toContain(`alter table public.${table} force row level security`);
    }
  });

  it("kullanıcı yalnızca kendi kayıtlarına erişir", () => {
    expect(rls).toContain("using (user_id = auth.uid() or public.is_admin())");
    expect(rls).toContain("with check (user_id = auth.uid())");
  });

  it("yetki yükseltme tetikleyici ile engellenir", () => {
    expect(rls).toContain("prevent_profile_privilege_escalation");
    expect(rls).toContain("Rol değiştirilemez.");
  });

  it("denetim kayıtları yalnızca yöneticiye açıktır ve değiştirilemez", () => {
    expect(rls).toContain("admin_audit_logs_select_admin");
    expect(rls).not.toMatch(/create policy .*admin_audit_logs.*\n\s*for (update|delete)/i);
  });
});
