/**
 * SAĞLAYICI OKUMA DENETİMİ — SADECE OKUR, HİÇBİR ŞEY YAZMAZ
 *
 *   npm run price:truncgil:collect-once
 *   npm run price:anlik:collect-once
 *
 * NE YAPAR
 * Adapter'ı gerçek kaynağa karşı çalıştırır ve çıkan fiyatları yazdırır.
 * Kaynağın sözleşmesi hâlâ geçerli mi, alan adları değişmiş mi, sayı biçimi
 * doğru mu — bunlar burada görünür.
 *
 * NE YAPMAZ
 * Veritabanına YAZMAZ. Üretimde fiyat yazma işi tek bir yoldan yapılır:
 * zamanlanmış `/api/cron/price-ingestion` ucu (bkz. `price:ingest:trigger`).
 * İki ayrı yazma yolu olsaydı biri kalite kapısını atlayabilirdi.
 *
 * Çıkış kodları:
 *   0  kaynak okundu ve en az bir fiyat üretildi
 *   75 kaynak şu an okunamadı (geçici)
 *   1  yapılandırma hatası veya sözleşme uyuşmazlığı
 */

import { getProviderInstance } from "@/prices/registry";

const CODE = process.argv[2] ?? "";

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  if (CODE === "") fail("Kullanım: provider-read-check.ts <providerCode>", 1);

  const provider = getProviderInstance(CODE);
  if (!provider) fail(`Bilinmeyen sağlayıcı: ${CODE}`, 1);

  const validation = provider.validateConfiguration();
  console.log(`Sağlayıcı : ${provider.providerId}`);
  console.log(`Piyasa    : ${provider.marketId}`);
  console.log(`Lisans    : ${provider.licenseStatus()}`);
  if (!validation.ok) {
    fail(
      `Yapılandırma eksik: ${validation.issues.map((issue) => issue.variable).join(", ")}\n` +
        "Özel pilot bayrakları olmadan bu kaynak çalışmaz.",
      1,
    );
  }

  const snapshot = await provider.fetchSnapshot([]);
  console.log(`Durum     : ${snapshot.status}${snapshot.safeErrorCode ? ` (${snapshot.safeErrorCode})` : ""}`);
  console.log(`Kaynak zamanı: ${snapshot.fetchedAt}`);
  console.log(`Gecikme   : ${String(snapshot.latencyMs ?? 0)} ms`);
  console.log("");

  if (snapshot.quotes.length === 0) {
    fail("Fiyat üretilmedi. Başka kaynağa DÜŞÜLMEZ; bu koşum geçici hata sayılır.", 75);
  }

  console.log("ürün                    bozdurma     yeniden alım   zaman kökeni");
  for (const quote of snapshot.quotes) {
    console.log(
      `${quote.canonicalProductId.padEnd(22)} ${quote.liquidationPrice.padStart(12)} ${quote.replacementPrice.padStart(
        14,
      )}   ${quote.timestampProvenance}`,
    );
  }
  console.log(`\n${String(snapshot.quotes.length)} ürün okundu. (Veritabanına yazılmadı.)`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
