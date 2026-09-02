/**
 * Data API sınır sondası — GERÇEK JWT ile PostgREST üzerinden.
 *
 *   npm run test:data-api
 *
 * pgTAP testleri rolü veritabanı içinde üstlenir. Bu betik ise BFF'yi tamamen
 * atlayıp, bir saldırganın yapabileceği gibi, anon anahtarı ve geçerli bir
 * "authenticated" JWT ile doğrudan Supabase Data API'ye istek atar ve
 * yazma yüzeyinin GERÇEKTEN kapalı olduğunu HTTP düzeyinde doğrular.
 *
 * Yalnızca yerel Supabase yığınına karşı çalışır (varsayılan: supabase start
 * adresleri ve bilinen yerel demo JWT secret'ı). Uzak projeye karşı
 * çalıştırmak için ortam değişkenleri verilmelidir; üretimde ÇALIŞTIRILMAZ.
 *
 * Çıkış kodu: 0 = tüm beklentiler karşılandı, 1 = sınır ihlali bulundu,
 * 2 = yığın erişilemez (test çalıştırılmadı).
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";

/**
 * Anahtarlar kaynak koda YAZILMAZ. Ortam değişkeni verilmemişse yerel yığının
 * değerleri `supabase status -o json` çıktısından okunur.
 */
function localStatus() {
  const result = spawnSync("npx", ["--no-install", "supabase", "status", "-o", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0 || !result.stdout) return {};
  try {
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  } catch {
    return {};
  }
}

const status = process.env.SUPABASE_PROBE_ANON_KEY ? {} : localStatus();

const API_URL = process.env.SUPABASE_PROBE_URL ?? status.API_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_PROBE_ANON_KEY ?? status.ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_PROBE_SERVICE_KEY ?? status.SERVICE_ROLE_KEY ?? "";
const JWT_SECRET = process.env.SUPABASE_PROBE_JWT_SECRET ?? status.JWT_SECRET ?? "";

if (!ANON_KEY || !SERVICE_KEY || !JWT_SECRET) {
  console.error("ATLANDI: Supabase anahtarları bulunamadı (yerel yığın çalışmıyor veya ortam değişkenleri eksik).");
  console.error("Yerel yığın için: npx supabase start   |   Uzak için: SUPABASE_PROBE_URL, _ANON_KEY, _SERVICE_KEY, _JWT_SECRET");
  process.exit(2);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Yerel yığının secret'ıyla imzalanmış gerçek bir authenticated JWT üretir. */
function signUserJwt(userId) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      aud: "authenticated",
      role: "authenticated",
      sub: userId,
      iss: `${API_URL}/auth/v1`,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function call(method, path, { token, body, prefer } = {}) {
  const headers = { apikey: ANON_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const failures = [];
let passed = 0;

function expect(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

function denied(result) {
  // PostgREST: yetki hatası 401 (anon) veya 403 (authenticated), kod 42501.
  return (
    (result.status === 401 || result.status === 403) &&
    (result.json?.code === "42501" || result.status === 401)
  );
}

async function main() {
  // Yığın erişilebilir mi?
  try {
    const health = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } });
    if (!health.ok && health.status !== 401 && health.status !== 403) throw new Error(String(health.status));
  } catch (error) {
    console.error(`ATLANDI: Supabase Data API erişilemez (${API_URL}): ${error.message}`);
    console.error("Yerel yığın için: npx supabase start");
    process.exit(2);
  }

  // Kurulum (service_role ile): gerçek auth kullanıcısı + profil (tetikleyici portföyü açar).
  const userId = randomUUID();
  const email = `probe-${userId.slice(0, 8)}@users.altin-takip.invalid`;
  const created = await fetch(`${API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: userId, email, password: "Probe7Parola!Kasa", email_confirm: true }),
  });
  if (!created.ok) {
    console.error(`Kurulum başarısız: auth kullanıcısı oluşturulamadı (${created.status}).`);
    console.error(await created.text());
    process.exit(2);
  }
  const createdUser = await created.json();
  const actualUserId = createdUser.id ?? userId;

  const profile = await call("POST", "/rest/v1/profiles", {
    token: SERVICE_KEY,
    prefer: "return=representation",
    body: {
      id: actualUserId,
      username: `probe${actualUserId.slice(0, 6)}`,
      display_name: "Data API Sondası",
      role: "user",
      status: "active",
      must_change_password: false,
    },
  });
  if (profile.status !== 201) {
    console.error(`Kurulum başarısız: profil oluşturulamadı (${profile.status}): ${profile.text}`);
    await cleanup(actualUserId);
    process.exit(2);
  }

  const portfolios = await call("GET", `/rest/v1/portfolios?user_id=eq.${actualUserId}&select=id`, {
    token: SERVICE_KEY,
  });
  const portfolioId = portfolios.json?.[0]?.id;

  console.log("");
  console.log("== Data API sınır sondası (gerçek JWT) ==");
  console.log(`Kullanıcı: ${actualUserId}`);
  console.log("");

  try {
    const userJwt = signUserJwt(actualUserId);

    // --- anon ---
    console.log("anon anahtarı (oturumsuz):");
    for (const table of ["profiles", "portfolios", "transactions", "app_sessions", "gold_products"]) {
      const result = await call("GET", `/rest/v1/${table}?select=*&limit=1`);
      expect(`anon ${table} okuyamaz`, denied(result), `${result.status} ${result.text.slice(0, 120)}`);
    }

    // --- authenticated okuma (RLS kapsamı) ---
    console.log("authenticated JWT (okuma):");
    const ownProfile = await call("GET", "/rest/v1/profiles?select=id,username", { token: userJwt });
    expect(
      "authenticated yalnızca kendi profilini görür",
      ownProfile.status === 200 && ownProfile.json?.length === 1 && ownProfile.json[0].id === actualUserId,
      `${ownProfile.status} ${ownProfile.text.slice(0, 120)}`,
    );
    const ownPortfolio = await call("GET", "/rest/v1/portfolios?select=id,user_id", { token: userJwt });
    expect(
      "authenticated yalnızca kendi portföyünü görür",
      ownPortfolio.status === 200 && ownPortfolio.json?.every((row) => row.user_id === actualUserId),
      `${ownPortfolio.status} ${ownPortfolio.text.slice(0, 120)}`,
    );
    const sessions = await call("GET", "/rest/v1/app_sessions?select=id", { token: userJwt });
    expect("authenticated app_sessions okuyamaz", denied(sessions), `${sessions.status}`);
    const limits = await call("GET", "/rest/v1/login_rate_limits?select=key_hash", { token: userJwt });
    expect("authenticated login_rate_limits okuyamaz", denied(limits), `${limits.status}`);
    const audit = await call("GET", "/rest/v1/admin_audit_logs?select=id", { token: userJwt });
    expect(
      "authenticated (admin değil) denetim kaydı göremez (RLS: boş liste)",
      audit.status === 200 && Array.isArray(audit.json) && audit.json.length === 0,
      `${audit.status} ${audit.text.slice(0, 120)}`,
    );

    // --- authenticated yazma (GRANT katmanı) ---
    console.log("authenticated JWT (yazma denemeleri):");
    const insertTx = await call("POST", "/rest/v1/transactions", {
      token: userJwt,
      prefer: "return=representation",
      body: {
        user_id: actualUserId,
        portfolio_id: portfolioId,
        product_id: "gram-altin",
        side: "buy",
        quantity: 1,
        unit: "gram",
        traded_at: "2026-02-01",
        unit_price: 5000,
      },
    });
    expect("authenticated kendi portföyüne işlem EKLEYEMEZ", denied(insertTx), `${insertTx.status} ${insertTx.text.slice(0, 120)}`);

    const patchPortfolio = await call("PATCH", `/rest/v1/portfolios?user_id=eq.${actualUserId}`, {
      token: userJwt,
      body: { name: "ele geçirildi" },
    });
    expect("authenticated portföy adını DEĞİŞTİREMEZ", denied(patchPortfolio), `${patchPortfolio.status} ${patchPortfolio.text.slice(0, 120)}`);

    const patchProfile = await call("PATCH", `/rest/v1/profiles?id=eq.${actualUserId}`, {
      token: userJwt,
      body: { role: "admin" },
    });
    expect("authenticated rolünü YÜKSELTEMEZ", denied(patchProfile), `${patchProfile.status} ${patchProfile.text.slice(0, 120)}`);

    const deleteTx = await call("DELETE", `/rest/v1/transactions?user_id=eq.${actualUserId}`, { token: userJwt });
    expect("authenticated işlem SİLEMEZ", denied(deleteTx), `${deleteTx.status} ${deleteTx.text.slice(0, 120)}`);

    const upsertPrefs = await call("POST", "/rest/v1/user_preferences", {
      token: userJwt,
      body: { user_id: actualUserId },
    });
    expect("authenticated tercih kaydı YAZAMAZ", denied(upsertPrefs), `${upsertPrefs.status} ${upsertPrefs.text.slice(0, 120)}`);

    // --- RPC yüzeyi ---
    console.log("authenticated JWT (RPC denemeleri):");
    const rpc = await call("POST", "/rest/v1/rpc/create_transaction_checked", {
      token: userJwt,
      body: {
        p_user_id: actualUserId,
        p_product_id: "gram-altin",
        p_side: "buy",
        p_quantity: 1,
        p_unit: "gram",
        p_traded_at: "2026-02-01",
        p_unit_price: 5000,
        p_fee_amount: 0,
        p_note: "",
      },
    });
    expect("authenticated create_transaction_checked ÇAĞIRAMAZ", denied(rpc) || rpc.status === 404, `${rpc.status} ${rpc.text.slice(0, 120)}`);

    const purge = await call("POST", "/rest/v1/rpc/purge_expired_sessions", { token: userJwt, body: {} });
    expect("authenticated purge_expired_sessions ÇAĞIRAMAZ", denied(purge) || purge.status === 404, `${purge.status} ${purge.text.slice(0, 120)}`);

    const repair = await call("POST", "/rest/v1/rpc/provision_missing_defaults", { token: userJwt, body: {} });
    expect("authenticated provision_missing_defaults ÇAĞIRAMAZ", denied(repair) || repair.status === 404, `${repair.status} ${repair.text.slice(0, 120)}`);

    const anonRpc = await call("POST", "/rest/v1/rpc/login_rate_limit_check", {
      body: { p_key_hash: "x", p_max_attempts: 5, p_window_ms: 1, p_base_lock_ms: 1, p_max_lock_ms: 1 },
    });
    expect("anon login_rate_limit_check ÇAĞIRAMAZ", denied(anonRpc) || anonRpc.status === 404, `${anonRpc.status} ${anonRpc.text.slice(0, 120)}`);

    // --- BFF (service_role) yolu çalışır: sınır yanlış tarafı kapatmamış ---
    console.log("service_role (BFF yolu):");
    const bffRpc = await call("POST", "/rest/v1/rpc/create_transaction_checked", {
      token: SERVICE_KEY,
      body: {
        p_user_id: actualUserId,
        p_product_id: "gram-altin",
        p_side: "buy",
        p_quantity: 1,
        p_unit: "gram",
        p_traded_at: "2026-02-01",
        p_unit_price: 5000,
        p_fee_amount: 0,
        p_note: "",
      },
    });
    expect("service_role create_transaction_checked ile işlem yazar", bffRpc.status === 200, `${bffRpc.status} ${bffRpc.text.slice(0, 160)}`);

    const ownTx = await call("GET", "/rest/v1/transactions?select=id,user_id", { token: userJwt });
    expect(
      "authenticated BFF'nin yazdığı kendi işlemini okur (RLS ikinci katman)",
      ownTx.status === 200 && ownTx.json?.length === 1 && ownTx.json[0].user_id === actualUserId,
      `${ownTx.status} ${ownTx.text.slice(0, 120)}`,
    );
  } finally {
    await cleanup(actualUserId);
  }

  console.log("");
  console.log(`Sonuç: ${passed} beklenti karşılandı, ${failures.length} ihlal.`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

async function cleanup(userId) {
  // auth.users silinince profil/portföy/işlem cascade ile temizlenir.
  await fetch(`${API_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  }).catch(() => undefined);
}

main().catch((error) => {
  console.error("Sonda beklenmeyen hata ile durdu:", error);
  process.exit(2);
});
