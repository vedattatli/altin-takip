/**
 * EKRAN EŞLEME ONAYI (yönetici aksiyonu)
 *
 *   node scripts/approve-mappings.mjs
 *
 * Sarraf TV ekranı "ÇEYREK / YARIM / TAM ALTIN" satırlarında yeni-eski ayrımı
 * YAPMAZ. Bu yüzden eşleme piyasa teamülüne dayanır (CONVENTION) ve kendiliğinden
 * değerlemeye GİRMEZ; yöneticinin açık onayı gerekir.
 *
 * Bu betik onayı `price_mapping_approve` üzerinden kaydeder: onaylayan yönetici
 * ve zaman denetim kaydına yazılır, güven seviyesi OPERATOR_VERIFIED olur.
 *
 * Kanıt olarak EKRANDA O AN OKUNAN değerler kullanılır — uydurma değer yazılmaz.
 * Ekran o an okunamıyorsa betik hiçbir şey onaylamaz.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = JSON.parse(readFileSync(join(homedir(), "altin-takip-pilot-secrets", "vercel-env.json"), "utf8"));
const URL = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const KEY = env.SUPABASE_SECRET_KEY;

const PROVIDER = "sarraf-tv-kayseri-screen";
/*
 * Eşleme sürümü 4'e yükseldi (ATA - REŞAT satırları GROUPED_EXPLICIT oldu).
 * Onaylar SÜRÜME bağlıdır: sürüm değişince eski onaylar geçersiz sayılır ve
 * eşleme yeniden onaylanmadan değerlemeye giremez. Bu kasıtlıdır — eşleme
 * tablosu değişmişken eski onayı taşımak, onaylanmamış bir eşlemeyi
 * onaylanmış göstermek olurdu.
 */
const MAPPING_VERSION = "sarraf-tv-screen-observed-4";

/** Onaylanacak eşlemeler: ham ekran etiketi → uygulama ürünü. */
const APPROVALS = [
  { label: "ÇEYREK", product: "yeni-ceyrek" },
  { label: "YARIM", product: "yeni-yarim" },
  { label: "TAM ALTIN", product: "yeni-tam" },
];

async function rpc(name, body) {
  const response = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  // Yönetici kimliği: rolü admin olan hesap.
  const profiles = await fetch(`${URL}/rest/v1/profiles?select=id,username&role=eq.admin`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  if (!Array.isArray(profiles) || profiles.length !== 1) {
    console.error("Tek bir yönetici hesabı bulunamadı; onay yapılmadı.");
    process.exit(1);
  }
  const admin = profiles[0];
  console.log(`Onaylayan yönetici: ${admin.username}\n`);

  // KANIT: ekranda o an okunan değerler. Uydurulmaz.
  const snapshot = await rpc("price_screen_rows_get", { p_code: PROVIDER });
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
    console.error("Ekran gözlemi yok; kanıt olmadan onay YAPILMAZ.");
    process.exit(1);
  }
  console.log(`Kanıt gözlemi: ${snapshot.observedAt}\n`);

  let approved = 0;
  for (const entry of APPROVALS) {
    const row = snapshot.rows.find((candidate) => candidate.rawLabel === entry.label);
    if (!row || row.buy === null || row.sell === null) {
      console.log(`  atlandı  ${entry.label} — ekranda iki yönlü değer yok`);
      continue;
    }
    await rpc("price_mapping_approve", {
      p_code: PROVIDER,
      p_label: entry.label,
      p_product: entry.product,
      p_version: MAPPING_VERSION,
      p_admin: admin.id,
      p_liquidation: Number(row.buy),
      p_replacement: Number(row.sell),
      p_observed: snapshot.observedAt,
      p_revoke: false,
    });
    console.log(`  onaylandı ${entry.label.padEnd(10)} → ${entry.product.padEnd(12)} (${row.buy} / ${row.sell})`);
    approved += 1;
  }

  console.log(`\n${approved}/${APPROVALS.length} eşleme onaylandı.`);
  const list = await rpc("price_mapping_approvals_list", { p_code: PROVIDER });
  console.log(`Kayıtlı onay sayısı: ${Array.isArray(list) ? list.length : 0}`);
}

void main();
