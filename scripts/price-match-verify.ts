/**
 * BİREBİR FİYAT EŞLEŞME DENETİMİ (canlı)
 *
 *   npm run price:match-verify
 *
 * Kayseri kaynaklı dört ürün için zincirin HER HALKASINI aynı koşumda okur ve
 * karşılaştırır:
 *
 *   1. EKRAN      tv.sarraf.pro üzerinde o an görünen değer
 *   2. TOPLAYICI  toplayıcının gönderdiği ham satır (price_screen_rows)
 *   3. VERİTABANI kabul edilmiş fiyat (current_price_quotes)
 *   4. PANEL      canlı uygulamada kullanıcının gördüğü değer
 *
 * Dördü de birebir aynı olmalıdır. Tek bir üründe uyuşmazlık varsa koşum
 * BAŞARISIZ sayılır ve uyuşmayan ürün raporlanır.
 *
 * GERÇEK KULLANICILARA DOKUNMAZ
 * Panel okuması için GEÇİCİ bir test kullanıcısı oluşturulur, sonunda
 * kullanıcı ve bütün verisi SİLİNİR. Vedat ve bilalozdemir hesaplarına
 * hiçbir işlem yapılmaz.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { chromium, type Browser } from "playwright-core";

import { READ_SCREEN_SCRIPT } from "../tools/experimental/sarraf-tv-kayseri/reader";
import { detectNumberFormat, parseScreenNumber } from "../src/prices/number-format";

const env = JSON.parse(
  readFileSync(join(homedir(), "altin-takip-pilot-secrets", "vercel-env.json"), "utf8"),
) as Record<string, string>;

const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/u, "");
const SERVICE_KEY = env.SUPABASE_SECRET_KEY!;
const EMAIL_DOMAIN = env.AUTH_INTERNAL_EMAIL_DOMAIN ?? "ozel.pilot";
const APP = process.env.APP_BASE_URL ?? "https://altin-takip-pilot.vercel.app";
const SCREEN_URL = process.env.SARRAF_SCREEN_URL ?? "https://tv.sarraf.pro/?mode=frame&slug=kayseri&code=383838";

const SCREEN_PROVIDER = "sarraf-tv-kayseri-screen";
const PLAN_PROVIDERS = ["sarraf-tv-kayseri-screen", "anlik-altin-kapalicarsi", "truncgil-turkiye"];

/** Karşılaştırılan dört ürün ve ekrandaki başlıkları. */
const PRODUCTS = [
  { id: "yeni-ceyrek", screenLabel: "ÇEYREK", panelLabel: "Çeyrek" },
  { id: "yeni-yarim", screenLabel: "YARIM", panelLabel: "Yarım" },
  { id: "yeni-tam", screenLabel: "TAM ALTIN", panelLabel: "Tam Altın" },
  { id: "gremse-altin", screenLabel: "GREMSE", panelLabel: "Gremse" },
] as const;

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${SUPABASE}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const rpc = <T>(name: string, body: unknown) =>
  rest<T>(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });

/** Ondalık metinleri kuruş hassasiyetinde karşılaştırır (kayan nokta yok). */
function sameMoney(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const norm = (value: string) => {
    const [whole, frac = ""] = value.trim().split(".");
    return `${whole!.replace(/^0+(?=\d)/u, "")}.${frac.padEnd(2, "0").slice(0, 2)}`;
  };
  return norm(a) === norm(b);
}

/** "11.000,00" → "11000.00" */
function fromTurkish(text: string): string | null {
  const match = /-?[\d.]+,\d{2}/u.exec(text);
  if (!match) return null;
  return match[0].replace(/\./gu, "").replace(",", ".");
}

// --------------------------------------------------------------- 1. EKRAN

interface ScreenValue {
  buy: string | null;
  sell: string | null;
}

async function readScreen(browser: Browser): Promise<Map<string, ScreenValue>> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(SCREEN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  interface Reading {
    rows: { label: string; cells: Record<string, string> }[];
    headers: string[];
  }
  let reading: Reading = { rows: [], headers: [] };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    reading = (await page.evaluate(READ_SCREEN_SCRIPT)) as Reading;
    const filled = reading.rows.some((row) => Object.values(row.cells).some((cell) => /[1-9]/u.test(cell)));
    if (filled && reading.headers.length >= 2) break;
    await page.waitForTimeout(2_000);
  }
  await context.close();

  const format = detectNumberFormat(reading.rows.flatMap((row) => Object.values(row.cells)));
  const values = new Map<string, ScreenValue>();
  for (const entry of PRODUCTS) {
    const row = reading.rows.find(
      (candidate) => candidate.label.trim().toLocaleUpperCase("tr-TR") === entry.screenLabel,
    );
    values.set(entry.id, {
      buy: row ? parseScreenNumber(row.cells["ALIŞ"] ?? "", format) : null,
      sell: row ? parseScreenNumber(row.cells["SATIŞ"] ?? "", format) : null,
    });
  }
  return values;
}

// ------------------------------------------ 2 + 3. TOPLAYICI ve VERİTABANI

async function readCollectorRows(): Promise<Map<string, ScreenValue>> {
  const snapshot = await rpc<{ rows: { rawLabel: string; buy: string | null; sell: string | null }[] } | null>(
    "price_screen_rows_get",
    { p_code: SCREEN_PROVIDER },
  );
  const values = new Map<string, ScreenValue>();
  for (const entry of PRODUCTS) {
    const row = snapshot?.rows.find(
      (candidate) => candidate.rawLabel.trim().toLocaleUpperCase("tr-TR") === entry.screenLabel,
    );
    values.set(entry.id, { buy: row?.buy ?? null, sell: row?.sell ?? null });
  }
  return values;
}

async function readDatabase(): Promise<Map<string, ScreenValue>> {
  const rows = await rest<{ canonical_product_id: string; liquidation_price: string; replacement_price: string }[]>(
    `/rest/v1/current_price_quotes?select=canonical_product_id,liquidation_price,replacement_price,provider_id` +
      `&order=canonical_product_id`,
  );
  const providers = await rest<{ id: string; code: string }[]>("/rest/v1/price_providers?select=id,code");
  const screenId = providers.find((provider) => provider.code === SCREEN_PROVIDER)?.id;
  const values = new Map<string, ScreenValue>();
  for (const entry of PRODUCTS) {
    const row = rows.find(
      (candidate) =>
        candidate.canonical_product_id === entry.id &&
        (candidate as unknown as { provider_id: string }).provider_id === screenId,
    );
    values.set(entry.id, { buy: row?.liquidation_price ?? null, sell: row?.replacement_price ?? null });
  }
  return values;
}

// --------------------------------------------------------------- 4. PANEL

interface TempUser {
  id: string;
  username: string;
  password: string;
}

async function createTempUser(): Promise<TempUser> {
  const username = `dogrulama${Date.now().toString(36)}`.toLowerCase().slice(0, 20);
  const password = `Dg!${randomBytes(12).toString("base64url")}`;
  const created = await rest<{ id: string }>("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: `${username}@${EMAIL_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { username, display_name: "Fiyat Doğrulama" },
    }),
  });

  await rest("/rest/v1/profiles", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: created.id,
      username,
      display_name: "Fiyat Doğrulama",
      role: "user",
      status: "active",
      must_change_password: false,
    }),
  });
  await rpc("provision_user_defaults", { p_user_id: created.id });

  const admin = (await rest<{ id: string }[]>("/rest/v1/profiles?select=id&role=eq.admin"))[0]!;
  for (const code of PLAN_PROVIDERS) {
    await rpc("experimental_access_set", {
      p_user_id: created.id,
      p_code: code,
      p_enabled: true,
      p_admin: admin.id,
      p_reason: "gecici fiyat dogrulamasi",
      p_expires: null,
    });
  }

  // Dört ürünün de panelde fiyatı görünsün diye birer adet eklenir.
  for (const entry of PRODUCTS) {
    await rpc("ledger_append", {
      p_user_id: created.id,
      p_payload: {
        clientRequestId: randomBytes(16).toString("hex"),
        kind: "BUY",
        productId: entry.id,
        quantity: "1",
        occurredAt: "2026-01-02",
        pricingInputMode: "UNIT_PRICE",
        unitPrice: "1000",
      },
    });
  }

  return { id: created.id, username, password };
}

async function deleteTempUser(user: TempUser): Promise<boolean> {
  const response = await fetch(`${SUPABASE}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return response.ok;
}

async function readPanel(browser: Browser, user: TempUser): Promise<Map<string, ScreenValue>> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "tr-TR" });
  const page = await context.newPage();
  await page.goto(`${APP}/giris`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
  await page.getByLabel("Kullanıcı adı").fill(user.username);
  await page.getByLabel("Parola", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await page.waitForURL("**/panel", { timeout: 30_000 });
  await page.waitForSelector('[data-testid="holdings-list"]', { timeout: 30_000 });

  const values = new Map<string, ScreenValue>();
  for (const entry of PRODUCTS) {
    const row = page.locator('[data-testid="holding-row"]', { hasText: entry.panelLabel }).first();
    const text = (await row.textContent()) ?? "";
    // "Bozdurma: 11.000,00/adet · Yeniden alım: 11.550,00/adet"
    const buyPart = /Bozdurma:\s*([\d.]+,\d{2})/u.exec(text)?.[1] ?? null;
    const sellPart = /Yeniden alım:\s*([\d.]+,\d{2})/u.exec(text)?.[1] ?? null;
    values.set(entry.id, {
      buy: buyPart ? fromTurkish(buyPart) : null,
      sell: sellPart ? fromTurkish(sellPart) : null,
    });
  }
  await context.close();
  return values;
}

// ------------------------------------------------------------------ KOŞUM

async function main(): Promise<void> {
  console.log("\nBİREBİR FİYAT EŞLEŞME DENETİMİ");
  console.log("==============================\n");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let user: TempUser | null = null;
  let mismatches = 0;
  let compared = 0;

  try {
    const [screen, collector, database] = await Promise.all([
      readScreen(browser),
      readCollectorRows(),
      readDatabase(),
    ]);

    user = await createTempUser();
    console.log(`Geçici kullanıcı oluşturuldu: ${user.username}\n`);
    const panel = await readPanel(browser, user);

    console.log("ürün          ekran              toplayıcı          veritabanı         panel              sonuç");
    for (const entry of PRODUCTS) {
      for (const side of ["buy", "sell"] as const) {
        const values = [screen, collector, database, panel].map((source) => source.get(entry.id)?.[side] ?? null);
        const ok = values.every((value) => sameMoney(value, values[0]!));
        compared += 1;
        if (!ok) mismatches += 1;
        console.log(
          `${(entry.id + "/" + (side === "buy" ? "alış" : "satış")).padEnd(22)}` +
            values.map((value) => String(value ?? "—").padStart(12)).join(" ") +
            `   ${ok ? "eşit" : "UYUŞMUYOR"}`,
        );
      }
    }

    console.log(`\nKarşılaştırılan hücre: ${String(compared)} | uyuşmayan: ${String(mismatches)}`);
  } finally {
    if (user) {
      const removed = await deleteTempUser(user);
      console.log(`Geçici kullanıcı silindi: ${removed ? "evet" : "HAYIR — elle kontrol edin"}`);
    }
    await browser.close().catch(() => undefined);
  }

  if (mismatches > 0) process.exit(1);
}

void main();
