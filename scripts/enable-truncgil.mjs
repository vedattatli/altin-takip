/**
 * TRUNCGIL KAYNAĞINI ETKİNLEŞTİR (yönetici aksiyonu)
 *
 *   node scripts/enable-truncgil.mjs
 *
 * Kaynak deneyseldir: genel kullanıcı listesine AÇILMAZ (veritabanı kısıtı da
 * bunu engeller). Erişim portföy bazlı izin listesiyle verilir.
 *
 * Bu betik yalnızca ZATEN izin listesinde olan kullanıcılara Truncgil izni de
 * ekler; yeni kullanıcıya kendiliğinden erişim vermez.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = JSON.parse(readFileSync(join(homedir(), "altin-takip-pilot-secrets", "vercel-env.json"), "utf8"));
const URL = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const KEY = env.SUPABASE_SECRET_KEY;

const CODE = "truncgil-turkiye";
const SCREEN = "sarraf-tv-kayseri-screen";

async function api(path, init = {}) {
  const response = await fetch(`${URL}${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const rpc = (name, body) => api(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });

async function main() {
  // 1. Sağlayıcı satırı katalog eşitlemesiyle oluşmuş olmalı.
  const providers = await api(`/rest/v1/price_providers?select=code,license_status,enabled,user_selectable&code=eq.${CODE}`);
  if (!Array.isArray(providers) || providers.length === 0) {
    console.error(`Sağlayıcı satırı yok: ${CODE}. Önce uygulamada bir yönetim sayfası açılmalı (katalog eşitlemesi).`);
    process.exit(1);
  }
  console.log("Sağlayıcı bulundu:", JSON.stringify(providers[0]));

  // 2. Etkinleştir — genel listeye AÇMADAN.
  await rpc("price_provider_set_flags", { p_code: CODE, p_enabled: true, p_user_selectable: false });
  console.log("Etkinleştirildi (user_selectable=false).");

  // 3. Genel listeye açmayı DENE: veritabanı reddetmeli.
  try {
    await rpc("price_provider_set_flags", { p_code: CODE, p_enabled: true, p_user_selectable: true });
    console.error("UYARI: genel listeye açılabildi — bu BEKLENMEYEN bir durumdur.");
  } catch (error) {
    console.log("Genel listeye açma reddedildi (beklenen):", String(error.message).slice(0, 90));
  }

  // 4. Ekran kaynağına izni olan kullanıcılara Truncgil iznini de ver.
  const admin = (await api("/rest/v1/profiles?select=id,username&role=eq.admin"))[0];
  const existing = await rpc("experimental_access_list", { p_code: SCREEN });
  const allowed = Array.isArray(existing) ? existing.filter((row) => row.enabled) : [];
  console.log(`\nEkran kaynağına izinli ${allowed.length} kullanıcı bulundu.`);

  for (const row of allowed) {
    const profile = (await api(`/rest/v1/profiles?select=id&username=eq.${row.username}`))[0];
    await rpc("experimental_access_set", {
      p_user_id: profile.id,
      p_code: CODE,
      p_enabled: true,
      p_admin: admin.id,
      p_reason: "ozel pilot - ikinci kaynak",
      p_expires: null,
    });
    console.log(`  izin verildi: ${row.username}`);
  }

  const final = await api(`/rest/v1/price_providers?select=code,license_status,enabled,user_selectable&code=eq.${CODE}`);
  console.log("\nSon durum:", JSON.stringify(final[0]));
}

void main();
