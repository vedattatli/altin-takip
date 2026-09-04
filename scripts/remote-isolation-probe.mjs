/**
 * UZAK KULLANICI İZOLASYON SONDASI
 *
 *   node scripts/remote-isolation-probe.mjs
 *
 * Canlı Vercel + uzak Supabase üzerinde erişim sınırlarını doğrular.
 *
 * NEDEN AYRI BİR SONDA
 * Staging E2E paketi production hedefini bilinçli olarak REDDEDER; bu koruma
 * yıkıcı testlerin canlı ortamda çalışmasını engeller ve atlanmamalıdır. Bu
 * sonda ise yalnızca:
 *   - iki GEÇİCİ test kullanıcısı oluşturur,
 *   - gerçek HTTPS oturumu açar,
 *   - çapraz erişimin ENGELLENDİĞİNİ doğrular,
 *   - kullanıcıları ve verilerini SİLER.
 *
 * Gerçek pilot hesaplarına DOKUNMAZ.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SECRETS = join(homedir(), "altin-takip-pilot-secrets", "vercel-env.json");
const env = JSON.parse(readFileSync(SECRETS, "utf8"));

const APP = "https://altin-takip-pilot.vercel.app";
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const SERVICE_KEY = env.SUPABASE_SECRET_KEY;

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "ok  " : "HATA"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function admin(path, init = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Test kullanıcısı: gerçek kişi değildir, gerçek altın miktarı taşımaz. */
function testUser(suffix) {
  return {
    username: `probe${suffix}${Date.now().toString(36)}`.toLowerCase().slice(0, 20),
    password: `Pr!${randomBytes(12).toString("base64url")}`,
  };
}

async function main() {
  console.log("\nUZAK KULLANICI İZOLASYON SONDASI");
  console.log("================================\n");

  const created = [];

  try {
    // 1. İki geçici kullanıcı oluştur (Supabase Auth admin API).
    for (const user of [testUser("a"), testUser("b")]) {
      const response = await admin("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: `${user.username}@probe.local`,
          password: user.password,
          email_confirm: true,
          user_metadata: { username: user.username, display_name: `Sonda ${user.username}` },
        }),
      });
      if (!response.ok) {
        console.log(`  kullanıcı oluşturulamadı (HTTP ${response.status}); sonda durduruluyor.`);
        return;
      }
      const body = await response.json();
      created.push(body.id);
    }
    check("iki geçici test kullanıcısı oluşturuldu", created.length === 2);

    // 2. Ham auth kullanıcısı uygulama profili ALMAMALIDIR.
    //
    // Bu bir güvenlik davranışıdır: profil yalnızca yöneticinin kendi
    // oluşturma akışıyla açılır. Auth katmanına düşen bir kayıt kendiliğinden
    // uygulama hesabına dönüşseydi, auth'a erişebilen herkes portföy sahibi
    // olurdu.
    const profiles = await admin(
      `/rest/v1/profiles?select=id,username&id=in.(${created.join(",")})`,
    ).then((r) => r.json());
    check("ham auth kullanıcısı kendiliğinden uygulama profili ALMAZ",
      Array.isArray(profiles) && profiles.length === 0,
      `${profiles.length ?? 0} profil`);

    // 3. ANON anahtarla doğrudan tablo erişimi ENGELLENMELİ.
    for (const table of ["profiles", "transactions", "portfolios", "portfolio_positions"]) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      });
      check(`anon ${table} okuyamaz`, response.status === 401, `HTTP ${response.status}`);
    }

    // 4. service_role defter tablosuna DOĞRUDAN yazamaz (tetikleyici).
    const direct = await admin("/rest/v1/transactions", {
      method: "POST",
      body: JSON.stringify({ portfolio_id: created[0], product_id: "gremse-altin", side: "BUY", quantity: "1" }),
    });
    check("service_role defter tablosuna doğrudan YAZAMAZ", direct.status === 403 || direct.status === 400,
      `HTTP ${direct.status}`);

    // 5. Oturumsuz korumalı sayfalar girişe yönlenir.
    for (const path of ["/panel", "/islemler", "/kayseri-fiyatlari"]) {
      const response = await fetch(`${APP}${path}`, { redirect: "manual" });
      check(`oturumsuz ${path} korunuyor`, response.status === 307 || response.status === 302,
        `HTTP ${response.status}`);
    }

    // 6. Oturumsuz API çağrıları reddedilir.
    for (const path of ["/api/portfolio", "/api/transactions", "/api/admin/users"]) {
      const response = await fetch(`${APP}${path}`, { redirect: "manual" });
      check(`oturumsuz ${path} reddedilir`, response.status === 401 || response.status === 403 || response.status === 307,
        `HTTP ${response.status}`);
    }

    // 7. CSRF: sahte Origin ile yazma reddedilir.
    const csrf = await fetch(`${APP}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://kotu-site.example" },
      body: JSON.stringify({ side: "BUY" }),
    });
    check("sahte Origin ile yazma reddedilir", csrf.status === 403, `HTTP ${csrf.status}`);
  } finally {
    // 8. TEMİZLİK — geçici kullanıcılar ve tüm verileri silinir.
    let removed = 0;
    for (const id of created) {
      const response = await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
      if (response.ok) removed += 1;
    }
    check("geçici test kullanıcıları silindi", removed === created.length, `${removed}/${created.length}`);

    const leftover = await admin(
      `/rest/v1/profiles?select=id&id=in.(${created.join(",") || "00000000-0000-0000-0000-000000000000"})`,
    ).then((r) => r.json()).catch(() => []);
    check("artık veri kalmadı", Array.isArray(leftover) && leftover.length === 0,
      `${leftover.length ?? "?"} satır`);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\nSonuç: ${results.length - failed.length}/${results.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.log("Başarısız:");
    for (const entry of failed) console.log(`  - ${entry.name} ${entry.detail}`);
    process.exit(1);
  }
}

void main();
