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

    // --- Muhasebe defteri (Sprint 1): defter RPC'leri ve türetilmiş tablolar ---
    console.log("authenticated JWT (defter / pozisyon):");
    const ledgerRpc = await call("POST", "/rest/v1/rpc/ledger_append", {
      token: userJwt,
      body: { p_user_id: actualUserId, p_payload: {} },
    });
    expect("authenticated ledger_append ÇAĞIRAMAZ", denied(ledgerRpc) || ledgerRpc.status === 404, `${ledgerRpc.status} ${ledgerRpc.text.slice(0, 120)}`);
    const ledgerListRpc = await call("POST", "/rest/v1/rpc/ledger_list", { token: userJwt, body: { p_user_id: actualUserId } });
    expect("authenticated ledger_list ÇAĞIRAMAZ (okuma bile BFF'den)", denied(ledgerListRpc) || ledgerListRpc.status === 404, `${ledgerListRpc.status}`);
    const positionsInsert = await call("POST", "/rest/v1/portfolio_positions", {
      token: userJwt,
      body: { portfolio_id: portfolioId, user_id: actualUserId, product_id: "gram-altin", quantity: "999" },
    });
    expect("authenticated portfolio_positions YAZAMAZ", denied(positionsInsert), `${positionsInsert.status} ${positionsInsert.text.slice(0, 120)}`);
    const positionsPatch = await call("PATCH", `/rest/v1/portfolio_positions?user_id=eq.${actualUserId}`, {
      token: userJwt,
      body: { quantity: "999" },
    });
    expect("authenticated portfolio_positions DEĞİŞTİREMEZ", denied(positionsPatch), `${positionsPatch.status} ${positionsPatch.text.slice(0, 120)}`);
    const snapshotInsert = await call("POST", "/rest/v1/price_snapshots", {
      token: userJwt,
      body: {
        user_id: actualUserId,
        product_id: "gram-altin",
        liquidation_price: "1",
        replacement_price: "1",
        provider: "sahte",
        market: "SAHTE",
        provider_status: "ok",
        provider_timestamp: new Date().toISOString(),
        fetched_at: new Date().toISOString(),
      },
    });
    expect("authenticated price_snapshots YAZAMAZ (sahte başlangıç fiyatı)", denied(snapshotInsert), `${snapshotInsert.status} ${snapshotInsert.text.slice(0, 120)}`);
    const servicePositionsPatch = await call("PATCH", `/rest/v1/portfolio_positions?user_id=eq.${actualUserId}`, {
      token: SERVICE_KEY,
      body: { quantity: "999" },
    });
    expect("service_role bile portfolio_positions'ı elle DEĞİŞTİREMEZ", denied(servicePositionsPatch), `${servicePositionsPatch.status} ${servicePositionsPatch.text.slice(0, 120)}`);

    // --- Sprint 1.1: service_role DOĞRUDAN defter/snapshot yazamaz; yalnızca RPC ---
    const serviceTxInsert = await call("POST", "/rest/v1/transactions", {
      token: SERVICE_KEY,
      prefer: "return=representation",
      body: {
        user_id: actualUserId,
        portfolio_id: portfolioId,
        product_id: "gram-altin",
        side: "buy",
        quantity: 1,
        unit: "gram",
        traded_at: "2026-02-01",
        occurred_at: "2026-01-31T21:00:00Z",
        unit_price: 5000,
      },
    });
    expect("service_role transactions tablosuna DOĞRUDAN INSERT yapamaz (yalnızca ledger_append)", denied(serviceTxInsert), `${serviceTxInsert.status} ${serviceTxInsert.text.slice(0, 120)}`);
    const serviceTxPatch = await call("PATCH", `/rest/v1/transactions?user_id=eq.${actualUserId}`, {
      token: SERVICE_KEY,
      body: { note: "elle" },
    });
    expect("service_role transactions tablosunu DOĞRUDAN UPDATE edemez", denied(serviceTxPatch), `${serviceTxPatch.status} ${serviceTxPatch.text.slice(0, 120)}`);
    const serviceTxDelete = await call("DELETE", `/rest/v1/transactions?user_id=eq.${actualUserId}`, { token: SERVICE_KEY });
    expect("service_role transactions tablosundan DOĞRUDAN DELETE edemez", denied(serviceTxDelete), `${serviceTxDelete.status} ${serviceTxDelete.text.slice(0, 120)}`);
    const serviceSnapshotInsert = await call("POST", "/rest/v1/price_snapshots", {
      token: SERVICE_KEY,
      body: {
        user_id: actualUserId,
        product_id: "gram-altin",
        liquidation_price: "1",
        replacement_price: "1",
        provider: "elle",
        market: "ELLE",
        provider_status: "ok",
        provider_timestamp: new Date().toISOString(),
        fetched_at: new Date().toISOString(),
      },
    });
    expect("service_role price_snapshots tablosuna DOĞRUDAN INSERT yapamaz", denied(serviceSnapshotInsert), `${serviceSnapshotInsert.status} ${serviceSnapshotInsert.text.slice(0, 120)}`);

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

    const ledgerAppend = await call("POST", "/rest/v1/rpc/ledger_append", {
      token: SERVICE_KEY,
      body: {
        p_user_id: actualUserId,
        p_payload: {
          kind: "BUY", product_id: "gram-altin", quantity: "0.1", unit: "gram", occurred_at: "2026-02-02",
          pricing_input_mode: "UNIT_PRICE", unit_price: "5000.33", total_amount: null, fees: "0", workmanship: "0",
          cost_basis_origin: "ACTUAL", note: "", client_request_id: "probe-req-0001",
        },
      },
    });
    expect("service_role ledger_append ile defter kaydı yazar", ledgerAppend.status === 200 && ledgerAppend.json?.transaction?.quantity === "0.1", `${ledgerAppend.status} ${ledgerAppend.text.slice(0, 160)}`);
    expect(
      "ledger_append girilen fiyatı (quoted) ve efektif maliyeti ayrı döner; occurredAtInstant Europe/Istanbul günün başlangıcıdır",
      ledgerAppend.json?.transaction?.quotedAcquisitionUnitPrice === "5000.33"
        && ledgerAppend.json?.transaction?.effectiveAcquisitionUnitCost === "5000.33"
        && ledgerAppend.json?.transaction?.occurredAtInstant === "2026-02-01T21:00:00.000Z"
        && ledgerAppend.json?.transaction?.occurredTime === null,
      `${ledgerAppend.status} ${ledgerAppend.text.slice(0, 240)}`,
    );
    const badDate = await call("POST", "/rest/v1/rpc/ledger_append", {
      token: SERVICE_KEY,
      body: {
        p_user_id: actualUserId,
        p_payload: {
          kind: "BUY", product_id: "gram-altin", quantity: "1", unit: "gram", occurred_at: "2026-02-30",
          pricing_input_mode: "UNIT_PRICE", unit_price: "5000", total_amount: null, fees: "0", workmanship: "0",
          cost_basis_origin: "ACTUAL", note: "", client_request_id: null,
        },
      },
    });
    expect("takvimde olmayan tarih (2026-02-30) RPC'de açık hatayla (P0004) reddedilir", badDate.status >= 400 && badDate.text.includes("P0004"), `${badDate.status} ${badDate.text.slice(0, 160)}`);
    const verify = await call("POST", "/rest/v1/rpc/ledger_verify", { token: SERVICE_KEY, body: { p_user_id: actualUserId } });
    expect("RPC sonrası projeksiyon defterle eşleşir (ledger_verify)", verify.status === 200 && Array.isArray(verify.json?.mismatches) && verify.json.mismatches.length === 0, `${verify.status} ${verify.text.slice(0, 160)}`);

    // --- Sprint 2: defter sürümü (senkronizasyon sinyali) ---
    const revision = await call("POST", "/rest/v1/rpc/ledger_revision", { token: SERVICE_KEY, body: { p_user_id: actualUserId } });
    expect("ledger_revision service_role ile okunur ve gerçek değişikliklerden sonra > 0", revision.status === 200 && Number(revision.json?.revision) > 0, `${revision.status} ${revision.text.slice(0, 120)}`);
    const revisionAsUser = await call("POST", "/rest/v1/rpc/ledger_revision", { token: userJwt, body: { p_user_id: actualUserId } });
    expect("authenticated ledger_revision ÇAĞIRAMAZ", denied(revisionAsUser) || revisionAsUser.status === 404, `${revisionAsUser.status}`);
    const revisionPatch = await call("PATCH", `/rest/v1/portfolios?user_id=eq.${actualUserId}`, { token: SERVICE_KEY, body: { ledger_revision: 999 } });
    expect("service_role defter sürümünü elle DEĞİŞTİREMEZ (tetikleyici)", revisionPatch.status >= 400, `${revisionPatch.status} ${revisionPatch.text.slice(0, 120)}`);

    const ledgerReplay = await call("POST", "/rest/v1/rpc/ledger_append", {
      token: SERVICE_KEY,
      body: { p_user_id: actualUserId, p_payload: { ...JSON.parse(JSON.stringify({
        kind: "BUY", product_id: "gram-altin", quantity: "0.1", unit: "gram", occurred_at: "2026-02-02",
        pricing_input_mode: "UNIT_PRICE", unit_price: "5000.33", total_amount: null, fees: "0", workmanship: "0",
        cost_basis_origin: "ACTUAL", note: "", client_request_id: "probe-req-0001",
      })) } },
    });
    expect("aynı istek kimliği tekrar gönderilince replay döner (idempotency)", ledgerReplay.status === 200 && ledgerReplay.json?.replayed === true, `${ledgerReplay.status} ${ledgerReplay.text.slice(0, 160)}`);
    const positions = await call("POST", "/rest/v1/rpc/positions_list", { token: SERVICE_KEY, body: { p_user_id: actualUserId } });
    const gramPosition = Array.isArray(positions.json) ? positions.json.find((p) => p.productId === "gram-altin") : null;
    expect("positions_list ondalık metin döner (1 + 0.1 = 1.1)", gramPosition?.quantity === "1.1", `${positions.status} ${positions.text.slice(0, 160)}`);
    const ownPositions = await call("GET", "/rest/v1/portfolio_positions?select=product_id,quantity", { token: userJwt });
    expect("authenticated kendi türetilmiş pozisyonunu okur (RLS)", ownPositions.status === 200 && ownPositions.json?.length === 1, `${ownPositions.status} ${ownPositions.text.slice(0, 120)}`);

    // --- Sprint 2: hesap silme cascade'i GERÇEKTEN kanıtlanır ---
    const baseline = await call("POST", "/rest/v1/rpc/ledger_append", {
      token: SERVICE_KEY,
      body: {
        p_user_id: actualUserId,
        p_payload: {
          kind: "OPENING_BALANCE", product_id: "yeni-ceyrek", quantity: "1", unit: "adet", occurred_at: "2026-02-05",
          pricing_input_mode: "MARKET_BASELINE", unit_price: null, total_amount: null, fees: "0", workmanship: "0",
          cost_basis_origin: "MARKET_BASELINE", note: "", client_request_id: null,
          baseline_snapshot: {
            product_id: "yeni-ceyrek", liquidation_price: "11000", replacement_price: "11300", provider: "mock", market: "TEST",
            currency: "TRY", provider_status: "ok", is_real_market_data: false,
            provider_timestamp: new Date().toISOString(), fetched_at: new Date().toISOString(), stale_after_ms: 300000,
          },
        },
      },
    });
    expect("cascade kurulumu: MARKET_BASELINE anlık görüntüsü oluşturuldu", baseline.status === 200 && Boolean(baseline.json?.transaction?.priceSnapshotId), `${baseline.status} ${baseline.text.slice(0, 160)}`);
    const sessionInsert = await call("POST", "/rest/v1/app_sessions", {
      token: SERVICE_KEY,
      prefer: "return=representation",
      body: { user_id: actualUserId, token_hash: `probe-${randomUUID()}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), absolute_expires_at: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect("cascade kurulumu: oturum satırı oluşturuldu", sessionInsert.status === 201, `${sessionInsert.status} ${sessionInsert.text.slice(0, 120)}`);
    const beforeCounts = await rowCounts(actualUserId);
    expect(
      "cascade öncesi: profil, portföy, işlem, anlık görüntü, pozisyon, oturum ve tercih satırları mevcut",
      Object.values(beforeCounts).every((count) => count > 0),
      JSON.stringify(beforeCounts),
    );
    const deleted = await deleteAuthUser(actualUserId);
    expect("auth.admin.deleteUser (gerçek auth ucu) başarılı", deleted.ok, `${deleted.status} ${deleted.text.slice(0, 120)}`);
    const afterCounts = await rowCounts(actualUserId);
    expect(
      "cascade sonrası: profiles, portfolios, transactions, price_snapshots, portfolio_positions, app_sessions, user_preferences = 0",
      Object.values(afterCounts).every((count) => count === 0),
      JSON.stringify(afterCounts),
    );
  } finally {
    const cleaned = await cleanup(actualUserId);
    if (!cleaned) {
      failures.push("temizlik: test kullanıcısı silinemedi (sessizce yok sayılmadı)");
    }
  }

  console.log("");
  console.log(`Sonuç: ${passed} beklenti karşılandı, ${failures.length} ihlal.`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

/** Kullanıcıya bağlı satır sayıları (service_role; RLS atlanır). */
async function rowCounts(userId) {
  const counts = {};
  const profiles = await call("GET", `/rest/v1/profiles?id=eq.${userId}&select=id`, { token: SERVICE_KEY });
  counts.profiles = Array.isArray(profiles.json) ? profiles.json.length : -1;
  for (const table of ["portfolios", "transactions", "price_snapshots", "portfolio_positions", "app_sessions", "user_preferences"]) {
    const result = await call("GET", `/rest/v1/${table}?user_id=eq.${userId}&select=user_id`, { token: SERVICE_KEY });
    counts[table] = Array.isArray(result.json) ? result.json.length : -1;
  }
  return counts;
}

/** Gerçek auth yönetim ucuyla siler; sonucu DÖNER (sessizce yok sayılmaz). */
async function deleteAuthUser(userId) {
  try {
    const response = await fetch(`${API_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: String(error) };
  }
}

/** Temizlik: kullanıcı zaten silinmişse (404) başarılı sayılır; başka hata açıkça raporlanır. */
async function cleanup(userId) {
  const result = await deleteAuthUser(userId);
  if (result.ok || result.status === 404) return true;
  const remaining = await rowCounts(userId).catch(() => null);
  if (remaining && Object.values(remaining).every((count) => count === 0)) return true;
  console.error(`Temizlik başarısız (${result.status}): ${result.text.slice(0, 160)}`);
  return false;
}

main().catch((error) => {
  console.error("Sonda beklenmeyen hata ile durdu:", error);
  process.exit(2);
});
