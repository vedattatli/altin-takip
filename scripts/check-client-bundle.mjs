/**
 * Üretim derlemesinden sonra istemci paketini tarar.
 *
 *   npm run verify:bundle
 *
 * Amaç: SUPABASE_SERVICE_ROLE_KEY veya "service_role" izinin tarayıcıya gönderilen
 * dosyalara sızmadığını doğrulamak. Bu betik derleme çıktısı üzerinde çalışır;
 * kaynak kod denetimi ayrıca tests/security-surface.test.ts içindedir.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIRS = [".next/static", "public"];

/** Aranan izler. Değer varsa gerçek anahtarın kendisi de aranır. */
const FORBIDDEN = [
  { label: "SUPABASE_SERVICE_ROLE_KEY adı", needle: "SUPABASE_SERVICE_ROLE_KEY" },
  { label: '"service_role" ibaresi', needle: "service_role" },
];

const actualKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (actualKey.length > 20) {
  FORBIDDEN.push({ label: "service_role anahtarının kendisi", needle: actualKey });
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const TEXT_EXTENSIONS = /\.(js|mjs|cjs|css|json|txt|map|html|webmanifest)$/i;

let scanned = 0;
const findings = [];

for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    if (!TEXT_EXTENSIONS.test(file)) continue;
    scanned += 1;
    const content = readFileSync(file, "utf8");
    for (const { label, needle } of FORBIDDEN) {
      if (content.includes(needle)) findings.push({ file, label });
    }
  }
}

if (scanned === 0) {
  console.error("İstemci paketi bulunamadı. Önce `npm run build` çalıştırın.");
  process.exit(1);
}

if (findings.length > 0) {
  console.error("GÜVENLİK HATASI: istemci paketinde yasaklı iz bulundu.");
  for (const finding of findings) {
    console.error(`  ${finding.file} -> ${finding.label}`);
  }
  process.exit(1);
}

console.log(`İstemci paketi temiz: ${scanned} dosya tarandı, service_role izi bulunamadı.`);
