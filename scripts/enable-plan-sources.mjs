/**
 * DEĞERLEME PLANINDAKİ KAYNAKLARI ETKİNLEŞTİR (yönetici aksiyonu)
 *
 *   node scripts/enable-plan-sources.mjs
 *
 * Plandaki üç kaynağı (Kayseri ekranı, Kapalıçarşı tablosu, Türkiye geneli)
 * etkinleştirir ve EKRAN kaynağına zaten izinli olan kullanıcılara diğer
 * ikisini de açar.
 *
 * Kurallar:
 *  - Hiçbiri genel kullanıcı listesine AÇILMAZ (veritabanı kısıtı da engeller).
 *    Betik bunu ayrıca dener ve reddedildiğini doğrular.
 *  - Yeni kullanıcıya kendiliğinden erişim VERİLMEZ; yalnız ekran kaynağına
 *    hâlihazırda izinli olanlara plan tamamlanır.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = JSON.parse(readFileSync(join(homedir(), "altin-takip-pilot-secrets", "vercel-env.json"), "utf8"));
const BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/u, "");
const KEY = env.SUPABASE_SECRET_KEY;

const SCREEN = "sarraf-tv-kayseri-screen";
/** Ekran kaynağı zaten açık; bu ikisi plana sonradan eklendi. */
const ADDITIONAL = ["anlik-altin-kapalicarsi", "truncgil-turkiye"];

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const rpc = (name, body) => api(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });

async function main() {
  const admin = (await api("/rest/v1/profiles?select=id,username&role=eq.admin"))[0];
  if (!admin) {
    console.error("Yönetici hesabı bulunamadı; hiçbir değişiklik yapılmadı.");
    process.exit(1);
  }
  console.log(`Yönetici: ${admin.username}\n`);

  for (const code of ADDITIONAL) {
    const rows = await api(
      `/rest/v1/price_providers?select=code,license_status,enabled,user_selectable&code=eq.${code}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      console.error(`Sağlayıcı satırı yok: ${code}. Önce katalog eşitlenmeli (uygulamada bir sayfa açın).`);
      process.exit(1);
    }

    await rpc("price_provider_set_flags", { p_code: code, p_enabled: true, p_user_selectable: false });
    console.log(`${code}: etkinleştirildi (user_selectable=false)`);

    // Genel listeye açmayı DENE: veritabanı reddetmeli.
    try {
      await rpc("price_provider_set_flags", { p_code: code, p_enabled: true, p_user_selectable: true });
      console.error(`  UYARI: ${code} genel listeye açılabildi — bu BEKLENMEYEN bir durumdur.`);
    } catch (error) {
      console.log(`  genel listeye açma reddedildi (beklenen): ${String(error.message).slice(0, 70)}`);
    }
  }

  const existing = await rpc("experimental_access_list", { p_code: SCREEN });
  const allowed = Array.isArray(existing) ? existing.filter((row) => row.enabled) : [];
  console.log(`\nEkran kaynağına izinli ${allowed.length} kullanıcı bulundu.`);

  for (const row of allowed) {
    const profile = (await api(`/rest/v1/profiles?select=id&username=eq.${row.username}`))[0];
    if (!profile) continue;
    for (const code of ADDITIONAL) {
      await rpc("experimental_access_set", {
        p_user_id: profile.id,
        p_code: code,
        p_enabled: true,
        p_admin: admin.id,
        p_reason: "hibrit kayseri degerleme plani",
        p_expires: null,
      });
    }
    console.log(`  izin verildi: ${row.username} → ${ADDITIONAL.join(", ")}`);
  }

  console.log("\nSon durum:");
  for (const code of [SCREEN, ...ADDITIONAL]) {
    const row = (
      await api(`/rest/v1/price_providers?select=code,enabled,user_selectable,license_status&code=eq.${code}`)
    )[0];
    console.log(`  ${JSON.stringify(row)}`);
  }
}

void main();
