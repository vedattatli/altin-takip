/**
 * Fiyat alımı duman testi (YALNIZCA yerel Supabase yığını).
 *
 *   npm run price:smoke
 *
 * Gerçek RPC yolundan: katalog eşitleme, lisans kapısı, idempotent alım,
 * karantina, kaynak seçimi ve denetim olayı doğrulanır. Dış sağlayıcıya
 * BAĞLANILMAZ; fiyatlar fixture'dan gelir.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { createUserActor, ownScope } from "../src/server/auth/actor";
import { ProviderNotSelectableError } from "../src/server/prices/types";

function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` -> ${detail}`}`);
  return ok;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
    console.error("ATLANDI: bu duman testi yalnızca yerel Supabase yığınına karşı çalışır.");
    process.exit(2);
  }

  const { SupabaseAuthBackend } = await import("../src/server/auth/supabase-backend");
  const { PriceIngestionService } = await import("../src/server/prices/ingestion-service");
  const { PriceSourceService } = await import("../src/server/prices/price-source-service");
  const backend = new SupabaseAuthBackend();
  await backend.ensureReady();

  const username = `pricesmoke${Date.now().toString(36)}`;
  const profile = await backend.createUser({
    username,
    displayName: "Fiyat Duman Testi",
    temporaryPassword: "Duman7Fiyat!Kasa",
    role: "user",
  });
  const actor = createUserActor(profile, "price-smoke");
  const scope = ownScope(actor);
  const ingestion = new PriceIngestionService(backend);
  const sources = new PriceSourceService(backend);
  let failures = 0;
  const pass = (label: string, ok: boolean, detail?: string) => {
    if (!check(label, ok, detail)) failures += 1;
  };

  try {
    console.log(`Kullanıcı: ${username}`);

    const synced = await ingestion.syncCatalog();
    pass("Katalog eşitlenir (idempotent)", synced > 0);
    const providers = await backend.listPriceProviders();
    pass("Bütün sağlayıcılar katalogda", providers.length >= 7, String(providers.length));
    pass(
      "Lisanssız kaynaklar varsayılan olarak kapalıdır",
      providers.filter((provider) => provider.licenseStatus !== "LICENSED" && provider.licenseStatus !== "DEV_ONLY")
        .every((provider) => !provider.enabled),
    );

    let licenseBlocked = false;
    try {
      await backend.setPriceProviderFlags("harem-direct", true, true);
    } catch (error) {
      licenseBlocked = error instanceof ProviderNotSelectableError || error instanceof Error;
    }
    pass("Lisanssız kaynak etkinleştirilemez", licenseBlocked);

    // Test sağlayıcısı yalnızca geliştirmede; duman testi yerel yığında çalışır.
    await backend.setPriceProviderFlags("mock", true, true);
    const first = await ingestion.ingestProvider("mock", { runKey: `smoke-${Date.now()}` });
    pass("Fiyat alımı uygulanır", first.result?.status === "SUCCESS" && first.accepted > 0, JSON.stringify(first.result));

    const runKey = `smoke-idem-${Date.now()}`;
    const a = await ingestion.ingestProvider("mock", { runKey });
    const b = await ingestion.ingestProvider("mock", { runKey });
    pass("Aynı koşum anahtarı iki kez uygulanmaz", b.result?.replayed === true && b.result?.runId === a.result?.runId);

    const quotes = await backend.currentPriceQuotes("mock");
    pass("Güncel fiyatlar okunur ve ondalık metindir", (quotes?.quotes.length ?? 0) > 0 && quotes!.quotes.every((quote) => typeof quote.liquidationPrice === "string"));

    const preference = await sources.selectSource(actor, "mock", "duman testi");
    pass("Kaynak seçimi çalışır", preference.changed && preference.providerCode === "mock");
    const events = await backend.listPriceSourceEvents(scope, 10);
    pass("Kaynak değişimi denetim olayı üretir", events.length === 1 && events[0]?.newProviderCode === "mock");

    const active = await sources.activeSnapshot(actor);
    pass("Aktif kaynak anlık görüntüsü döner", active.snapshot !== null && active.source.providerCode === "mock");

    let referenceBlocked = false;
    try {
      await sources.selectSource(actor, "bist-reference", "deneme");
    } catch {
      referenceBlocked = true;
    }
    pass("Referans kaynağı değerleme için seçilemez", referenceBlocked);

    const compare = await sources.compareSources(actor);
    pass("Karşılaştırma verisi döner", compare.providers.length >= 1 && compare.activeProviderCode === "mock");
  } finally {
    await backend.deleteUser(profile.id);
  }

  console.log("");
  console.log(failures === 0 ? "Fiyat alımı duman testi geçti." : `${failures} kontrol başarısız.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Duman testi çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
