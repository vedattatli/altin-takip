import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { NormalizedQuote } from "@/prices/contract";
import { PROVIDER_DESCRIPTORS, getProviderDescriptor } from "@/prices/descriptors";
import { evaluateQuote, evaluateSnapshot, compareWithReference } from "@/prices/quality";
import { describeProvider, listSelectableProviders, listProviderStatuses } from "@/prices/registry";
import { createProvider } from "@/prices/providers";
import { extractRecords } from "@/prices/providers/rest-provider";
import { ALTINAPI_MAPPING, HASFIYAT_MAPPING } from "@/prices/providers/mappings";

/**
 * SPRINT 3 — SAĞLAYICI SÖZLEŞMESİ VE KALİTE KAPISI
 *
 * Bu testler FIXTURE ile çalışır; gerçek API anahtarı gerektirmez ve hiçbir
 * dış servise bağlanmaz. Canlı entegrasyon testi ayrıdır ve credential yoksa
 * NOT_RUN olarak raporlanır (asla "geçti" denmez).
 */

const NOW = Date.parse("2026-03-01T10:00:00Z");
const nowIso = new Date(NOW).toISOString();
const KNOWN_PRODUCTS = new Set(GOLD_PRODUCTS.map((product) => product.id));

const ENV_KEYS = [
  "NODE_ENV",
  "SARRAFPRO_API_URL",
  "SARRAFPRO_API_KEY",
  "SARRAFPRO_MARKET_ID",
  "SARRAFPRO_LICENSE_REFERENCE",
  "SARRAFPRO_REDISTRIBUTION_ALLOWED",
  "ALTINAPI_API_URL",
  "ALTINAPI_API_KEY",
  "ALTINAPI_LICENSE_TIER",
  "ALTINAPI_REDISTRIBUTION_ALLOWED",
  "ALTINAPI_CONTRACT_VERSION",
  "HASFIYAT_CONTRACT_VERSION",
  "SARRAFPRO_CONTRACT_VERSION",
  "PRICE_ALLOW_MOCK_PROVIDER",
  "VERCEL_ENV",
  "APP_DEPLOYMENT_ENV",
  "HASFIYAT_API_URL",
  "HASFIYAT_API_KEY",
  "HASFIYAT_SOURCE",
  "HASFIYAT_LICENSE_REFERENCE",
  "HASFIYAT_REDISTRIBUTION_ALLOWED",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function licenseAltinApi(): void {
  process.env.ALTINAPI_API_URL = "https://ornek-saglayici.invalid/v1/prices";
  process.env.ALTINAPI_API_KEY = "test-anahtari-gercek-degil";
  process.env.ALTINAPI_LICENSE_TIER = "SOZLESME-2026-001";
  process.env.ALTINAPI_REDISTRIBUTION_ALLOWED = "true";
  // Operatör beyanı: yanıt şekli fixture ile doğrulanmış sözleşmeye uyuyor.
  process.env.ALTINAPI_CONTRACT_VERSION = "generic-json-1";
}

function fixtureResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("1. sağlayıcı kataloğu ve lisans kapısı", () => {
  it("bütün sağlayıcılar sözleşmeyi uygular ve kimlikleri benzersizdir", () => {
    const ids = PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const provider = createProvider(descriptor.providerId);
      expect(provider, descriptor.providerId).not.toBeNull();
      expect(provider!.providerId).toBe(descriptor.providerId);
      expect(provider!.marketId).toBe(descriptor.marketId);
      expect(typeof provider!.licenseStatus()).toBe("string");
      expect(provider!.getCapabilities().capabilities.length).toBeGreaterThan(0);
      expect(provider!.validateConfiguration()).toHaveProperty("issues");
    }
  });

  it("yapılandırılmamış sağlayıcı NOT_CONFIGURED olur ve VERİ ÇEKMEZ", async () => {
    const provider = createProvider("altinapi")!;
    expect(provider.licenseStatus()).toBe("NOT_CONFIGURED");
    let called = false;
    const snapshot = await provider.fetchSnapshot(["gram-altin"], {
      now: () => NOW,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toEqual([]);
    expect(snapshot.safeErrorCode).toBe("NOT_CONFIGURED");
  });

  it("yeniden gösterim izni yoksa lisans LICENSE_REQUIRED kalır ve veri çekilmez", async () => {
    licenseAltinApi();
    process.env.ALTINAPI_REDISTRIBUTION_ALLOWED = "false";
    const provider = createProvider("altinapi")!;
    expect(provider.licenseStatus()).toBe("LICENSE_REQUIRED");
    const snapshot = await provider.fetchSnapshot(["gram-altin"], { now: () => NOW });
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.safeErrorCode).toBe("LICENSE_REQUIRED");
    expect(describeProvider("altinapi")!.selectable).toBe(false);
  });

  it("lisans + izin varsa kaynak seçilebilir olur", () => {
    licenseAltinApi();
    const view = describeProvider("altinapi")!;
    expect(view.licenseStatus).toBe("LICENSED");
    expect(view.selectable).toBe(true);
    expect(view.licenseReference).toBe("SOZLESME-2026-001");
    expect(listSelectableProviders().map((item) => item.providerId)).toContain("altinapi");
  });

  it("KAYSARDER/Sarraf kaynağı yapılandırma yokken gerçek veri iddiasında BULUNMAZ", async () => {
    const provider = createProvider("sarraf-pro-kayseri")!;
    expect(provider.licenseStatus()).toBe("NOT_CONFIGURED");
    expect(provider.displayName).toBe("Kayseri Yerel Piyasa");
    // Kurum adı KAYSARDER'ın kendi sitesindeki resmî adıdır.
    expect(provider.technicalName).toContain("Kayseri Sarraflar ve Kuyumcular Derneği");
    expect(provider.technicalName).not.toContain("Kuyumcular Odası");
    const snapshot = await provider.fetchSnapshot(["gram-altin"], { now: () => NOW });
    expect(snapshot.quotes).toEqual([]);
    expect(snapshot.status).toBe("unavailable");
    const view = describeProvider("sarraf-pro-kayseri")!;
    expect(view.selectable).toBe(false);
    // KAYSARDER sayfası yalnızca referans bağlantısıdır; scrape edilmez.
    expect(view.referenceUrl).toContain("kaysarder");
  });

  it("Altınkaynak ve Harem doğrudan adapter'ları lisanssız aktive olmaz", async () => {
    for (const code of ["altinkaynak-direct", "harem-direct"]) {
      const provider = createProvider(code)!;
      expect(provider.licenseStatus(), code).toBe("LICENSE_REQUIRED");
      const snapshot = await provider.fetchSnapshot(["gram-altin"], { now: () => NOW });
      expect(snapshot.quotes, code).toEqual([]);
      expect(describeProvider(code)!.selectable, code).toBe(false);
    }
  });

  it("BIST referans sağlayıcısı birincil değerleme kaynağı OLAMAZ", () => {
    const provider = createProvider("bist-reference")!;
    expect(provider.getCapabilities().canBePrimary).toBe(false);
    expect(provider.getCapabilities().capabilities).toContain("REFERENCE_ONLY");
    const view = describeProvider("bist-reference")!;
    expect(view.selectable).toBe(false);
    expect(view.blockedReason).toMatch(/referans/i);
    expect(listSelectableProviders().map((item) => item.providerId)).not.toContain("bist-reference");
  });

  it("test sağlayıcısı üretimde kullanılamaz", async () => {
    // NODE_ENV tip düzeyinde salt okunurdur; testte geçici olarak değiştirilir.
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const provider = createProvider("mock")!;
      expect(provider.validateConfiguration().ok).toBe(false);
      const snapshot = await provider.fetchSnapshot(["gram-altin"], { now: () => NOW });
      expect(snapshot.status).toBe("unavailable");
      expect(snapshot.safeErrorCode).toBe("MOCK_DISABLED_IN_PRODUCTION");
      expect(describeProvider("mock")!.selectable).toBe(false);
      expect(listSelectableProviders().map((item) => item.providerId)).not.toContain("mock");
    } finally {
      if (previous === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previous;
    }
  });

  it("Harem'in resmî servisi iddiası hiçbir etikette geçmez", () => {
    for (const view of listProviderStatuses()) {
      expect(`${view.displayName} ${view.technicalName} ${view.attribution}`).not.toMatch(/Harem resmî/i);
    }
    expect(getProviderDescriptor("altinapi")!.attribution).toMatch(/bağımsız/i);
    expect(getProviderDescriptor("altinapi")!.attribution).toMatch(/resmî servisi değildir/i);
  });
});

describe("2. sembol eşleme ve normalizasyon (fixture)", () => {
  it("AltinAPI sembolleri kanonik ürünlere doğru eşlenir; bid liquidation, ask replacement olur", async () => {
    licenseAltinApi();
    const provider = createProvider("altinapi")!;
    const snapshot = await provider.fetchSnapshot(["gram-altin", "yeni-ceyrek"], {
      now: () => NOW,
      ingestionRunId: "run-1",
      fetchImpl: fixtureResponse({
        data: [
          { symbol: "GRAM_ALTIN", bid: "5000.25", ask: "5060.75", timestamp: nowIso, currency: "TRY" },
          { symbol: "CEYREK_YENI", bid: 11000, ask: 11300, timestamp: nowIso, currency: "TRY" },
          { symbol: "BILINMEYEN", bid: 1, ask: 2, timestamp: nowIso, currency: "TRY" },
        ],
      }),
    });
    expect(snapshot.status).toBe("ok");
    const gram = snapshot.quotes.find((quote) => quote.canonicalProductId === "gram-altin")!;
    expect(gram.liquidationPrice).toBe("5000.25");
    expect(gram.replacementPrice).toBe("5060.75");
    expect(gram.marketId).toBe("turkiye-genel");
    expect(gram.ingestionRunId).toBe("run-1");
    expect(gram.mappingVersion).toBe("altinapi-1");
    expect(gram.rawPayloadHash).toBeTruthy();
    // Eşlenmeyen sembol SESSİZCE başka ürüne yazılmaz.
    expect(snapshot.quotes).toHaveLength(2);
  });

  it("eşleme tablolarındaki bütün hedefler katalogda vardır", () => {
    for (const [symbol, productId] of Object.entries({ ...ALTINAPI_MAPPING, ...HASFIYAT_MAPPING })) {
      expect(KNOWN_PRODUCTS.has(productId), `${symbol} → ${productId}`).toBe(true);
    }
  });

  it("Hasfiyat çoklu kaynak verisi yanlış kaynak etiketi ALMAZ", async () => {
    process.env.HASFIYAT_API_URL = "https://ornek-saglayici.invalid/v1";
    process.env.HASFIYAT_API_KEY = "test-anahtari";
    process.env.HASFIYAT_LICENSE_REFERENCE = "SOZLESME-2026-002";
    process.env.HASFIYAT_REDISTRIBUTION_ALLOWED = "true";
    // Bu sözleşme sürümü, ucun yalnızca TL döndürdüğünü garanti eder.
    process.env.HASFIYAT_CONTRACT_VERSION = "generic-json-try-1";
    const provider = createProvider("hasfiyat")!;
    expect(provider.displayName).toBe("Hasfiyat Çoklu Kaynak");
    expect(provider.marketId).toBe("composite");
    const snapshot = await provider.fetchSnapshot(["gram-altin"], {
      now: () => NOW,
      fetchImpl: fixtureResponse([{ symbol: "GRAM_ALTIN", bid: "5000", ask: "5050", timestamp: nowIso }]),
    });
    const quote = snapshot.quotes[0]!;
    // Üst kaynak bildirilmediyse tek bir kurumun fiyatı gibi etiketlenmez.
    expect(quote.upstreamSourceId).toBeNull();
    expect(quote.marketId).toBe("composite");
    expect(getProviderDescriptor("hasfiyat")!.attribution).toMatch(/Çoklu Kaynak/);
  });

  it("Hasfiyat açık kaynak seçimi upstreamSourceId olarak korunur", async () => {
    process.env.HASFIYAT_API_URL = "https://ornek-saglayici.invalid/v1";
    process.env.HASFIYAT_API_KEY = "test-anahtari";
    process.env.HASFIYAT_LICENSE_REFERENCE = "SOZLESME-2026-002";
    process.env.HASFIYAT_REDISTRIBUTION_ALLOWED = "true";
    // Bu sözleşme sürümü, ucun yalnızca TL döndürdüğünü garanti eder.
    process.env.HASFIYAT_CONTRACT_VERSION = "generic-json-try-1";
    process.env.HASFIYAT_SOURCE = "kayseri-sarraf";
    const provider = createProvider("hasfiyat")!;
    let requestedUrl = "";
    const snapshot = await provider.fetchSnapshot(["gram-altin"], {
      now: () => NOW,
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify([{ symbol: "GRAM_ALTIN", bid: "5000", ask: "5050", timestamp: nowIso }]));
      }) as typeof fetch,
    });
    expect(requestedUrl).toContain("source=kayseri-sarraf");
    expect(snapshot.quotes[0]!.upstreamSourceId).toBe("kayseri-sarraf");
  });

  it("Türkçe biçimli ve gruplu sayılar doğru okunur; bozuk kayıt atlanır", async () => {
    licenseAltinApi();
    process.env.ALTINAPI_CONTRACT_VERSION = "generic-json-try-1";
    const provider = createProvider("altinapi")!;
    const snapshot = await provider.fetchSnapshot([], {
      now: () => NOW,
      fetchImpl: fixtureResponse({
        GRAM_ALTIN: { alis: "5.000,25", satis: "5.060,75", tarih: nowIso },
        ATA: { alis: "abc", satis: "1", tarih: nowIso },
      }),
    });
    const gram = snapshot.quotes.find((quote) => quote.canonicalProductId === "gram-altin")!;
    expect(gram.liquidationPrice).toBe("5000.25");
    expect(snapshot.quotes.some((quote) => quote.canonicalProductId === "ata-altin")).toBe(false);
  });

  it("sağlayıcı hata verirse güvenli kod döner ve secret sızmaz", async () => {
    licenseAltinApi();
    const provider = createProvider("altinapi")!;
    const snapshot = await provider.fetchSnapshot(["gram-altin"], {
      now: () => NOW,
      fetchImpl: fixtureResponse({ error: "unauthorized" }, 401),
    });
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.safeErrorCode).toBe("HTTP_401");
    expect(JSON.stringify(snapshot)).not.toContain("test-anahtari-gercek-degil");
  });

  it("yanıt biçimi esnektir: dizi, sarmalanmış dizi ve sembol anahtarlı nesne", () => {
    expect(extractRecords([{ symbol: "A" }])).toHaveLength(1);
    expect(extractRecords({ data: [{ symbol: "A" }] })).toHaveLength(1);
    expect(extractRecords({ A: { bid: 1 } })[0]).toMatchObject({ symbol: "A" });
    expect(extractRecords(null)).toEqual([]);
  });
});

describe("3. kalite kapısı ve karantina", () => {
  function quote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
    return {
      canonicalProductId: "gram-altin",
      providerId: "altinapi",
      upstreamSourceId: null,
      marketId: "turkiye-genel",
      liquidationPrice: "5000",
      replacementPrice: "5050",
      currency: "TRY",
      timestampProvenance: "UPSTREAM",
      providerTimestamp: nowIso,
      fetchedAt: nowIso,
      status: "ok",
      staleAfterMs: 5 * 60_000,
      rawPayloadHash: "hash",
      mappingVersion: "altinapi-1",
      licenseReference: null,
      ingestionRunId: null,
      ...overrides,
    };
  }

  const context = {
    providerId: "altinapi" as const,
    marketId: "turkiye-genel" as const,
    knownProductIds: KNOWN_PRODUCTS,
    now: NOW,
  };

  it("geçerli quote kabul edilir", () => {
    expect(evaluateQuote(quote(), context).ok).toBe(true);
  });

  it("ters makas, sıfır fiyat, yanlış piyasa/sağlayıcı/para birimi reddedilir", () => {
    expect(evaluateQuote(quote({ replacementPrice: "4999" }), context)).toMatchObject({ code: "INVERTED_SPREAD" });
    expect(evaluateQuote(quote({ liquidationPrice: "0" }), context)).toMatchObject({ code: "PRICE_NOT_POSITIVE" });
    expect(evaluateQuote(quote({ marketId: "kayseri" }), context)).toMatchObject({ code: "MARKET_MISMATCH" });
    expect(evaluateQuote(quote({ providerId: "hasfiyat" }), context)).toMatchObject({ code: "PROVIDER_MISMATCH" });
    expect(evaluateQuote(quote({ currency: "USD" as "TRY" }), context)).toMatchObject({ code: "CURRENCY_NOT_TRY" });
    expect(evaluateQuote(quote({ canonicalProductId: "bitcoin" }), context)).toMatchObject({ code: "PRODUCT_UNKNOWN" });
    expect(evaluateQuote(quote({ status: "stale" }), context)).toMatchObject({ code: "STATUS_NOT_OK" });
  });

  it("bayat ve gelecek zamanlı fiyat reddedilir", () => {
    const stale = new Date(NOW - 10 * 60_000).toISOString();
    expect(evaluateQuote(quote({ providerTimestamp: stale, fetchedAt: stale }), context)).toMatchObject({ code: "STALE" });
    const future = new Date(NOW + 10 * 60_000).toISOString();
    expect(evaluateQuote(quote({ providerTimestamp: future }), context)).toMatchObject({ code: "TIMESTAMP_FUTURE" });
    expect(evaluateQuote(quote({ providerTimestamp: "dün" }), context)).toMatchObject({ code: "TIMESTAMP_INVALID" });
  });

  it("aşırı fiyat sıçraması karantinaya alınır ve eşiği yapılandırılabilir", () => {
    const withPrevious = { ...context, previousLiquidation: () => 4000 };
    expect(evaluateQuote(quote(), withPrevious)).toMatchObject({ code: "PRICE_JUMP" });
    expect(evaluateQuote(quote(), { ...withPrevious, policy: { maxChangeRatio: 0.5 } }).ok).toBe(true);
  });

  it("karantinaya alınan quote değerlemeye girmez", () => {
    const result = evaluateSnapshot(
      [quote(), quote({ canonicalProductId: "yeni-ceyrek", replacementPrice: "1" })],
      context,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.quarantined[0]!.code).toBe("INVERTED_SPREAD");
  });

  it("referans sağlayıcı yalnızca sapma raporlar; fiyatın yerine geçmez", () => {
    const deviations = compareWithReference(
      [quote()],
      [quote({ providerId: "bist-reference", marketId: "bist", liquidationPrice: "4000" })],
    );
    expect(deviations).toHaveLength(1);
    expect(deviations[0]!.productId).toBe("gram-altin");
  });
});

describe("4. secret ve kaynak sınırı", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  it("sağlayıcı API anahtarları istemci bileşenlerinde okunmaz", () => {
    const clientFiles = walk("src").filter((file) => readFileSync(file, "utf8").startsWith('"use client"'));
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      for (const key of ["ALTINAPI_API_KEY", "HASFIYAT_API_KEY", "SARRAFPRO_API_KEY", "PRICE_CRON_SECRET"]) {
        expect(source, `${file} → ${key}`).not.toContain(key);
      }
    }
  });

  it("hiçbir sağlayıcı anahtarı NEXT_PUBLIC_ önekiyle kullanılmaz", () => {
    for (const file of walk("src")) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(API_KEY|SECRET|LICENSE)/);
    }
  });

  it("sağlayıcı kodunda HTML scraping veya gizli endpoint izi yoktur", () => {
    for (const file of walk(join("src", "prices"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/cheerio|jsdom|querySelector|innerHTML|text\/html/i);
      // Sözleşmesi bilinmeyen kaynaklar için sabit endpoint YAZILMAZ.
      expect(source, file).not.toMatch(/https?:\/\/(tv\.sarraf|www\.kaysarder\.org\.tr\/[a-z])/i);
    }
  });

  it("migration 0013/0014 fiyat tablolarını istemciye kapatır ve credential saklamaz", () => {
    const schema = readFileSync(join("supabase", "migrations", "0013_price_providers.sql"), "utf8");
    const rpc = readFileSync(join("supabase", "migrations", "0014_price_rpc.sql"), "utf8");
    expect(schema).toContain("revoke all on table %s from authenticated");
    expect(schema).toContain("grant select on table %s to service_role");
    expect(schema).not.toMatch(/api_key|secret_key|password/i);
    expect(schema).toContain("price_quote_history_no_update");
    expect(rpc).toContain("pg_try_advisory_xact_lock");
    expect(rpc).toContain("ALTIN_PROVIDER_LICENSE_REQUIRED");
    expect(rpc).toContain("grant execute on function %s to service_role");
  });
});
