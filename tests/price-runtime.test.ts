import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectScreenQuotes, screenSignatureValid } from "@/prices/providers/sarraf-tv-screen-collector";
import { screenLabelToProduct } from "@/prices/providers/sarraf-tv-screen-mapping";
import { PROVIDER_DESCRIPTORS } from "@/prices/descriptors";
import { createProvider } from "@/prices/providers";
import { evaluateQuote, type QuoteRejectionCode } from "@/prices/quality";
import { describeProvider } from "@/prices/registry";
import type { NormalizedQuote } from "@/prices/contract";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { MfaService } from "@/server/auth/mfa-service";
import { totpCode } from "@/server/auth/totp";
import { PriceIngestionService } from "@/server/prices/ingestion-service";
import { PriceSourceService } from "@/server/prices/price-source-service";
import { machineAuthorized, machineRunKey } from "@/server/security/machine-route";
import {
  classifyHeader,
  detectNumberFormat,
  extractQuotes,
  parseScreenNumber,
  verifyAgainstScreenText,
  type RawScreenRow,
} from "../tools/experimental/sarraf-tv-kayseri/extract";
import { findForbiddenTraces, safeQueryKeys, templatePath } from "../tools/experimental/sarraf-tv-kayseri/sanitize";
import { adminActor, userActor } from "./actors";

/**
 * SPRINT 3.1 — FİYAT ÇALIŞMA ZAMANI BÜTÜNLÜĞÜ
 *
 * Bu dosya, mimarinin "doğru görünen ama gerçek akışta çalışmayan" parçalarını
 * denetler: cron kimliği, devre kesici, karantina kalıcılığı, adapter semantiği,
 * TOTP replay koruması ve ekran fizibilitesinin saf mantığı.
 */

const ENV_KEYS = [
  "NODE_ENV",
  "PRICE_CRON_SECRET",
  "PRICE_ALLOW_MOCK_PROVIDER",
  "AUTH_ALLOW_LOCAL_BACKEND",
  "AUTH_MFA_ENCRYPTION_KEY",
  "VERCEL_ENV",
  "APP_DEPLOYMENT_ENV",
  "PRICE_EXPERIMENTAL_SARRAF_SCREEN",
  "ALTINAPI_API_URL",
  "ALTINAPI_API_KEY",
  "ALTINAPI_LICENSE_TIER",
  "ALTINAPI_REDISTRIBUTION_ALLOWED",
  "ALTINAPI_CONTRACT_VERSION",
  "SARRAFPRO_API_URL",
  "SARRAFPRO_API_KEY",
  "SARRAFPRO_MARKET_ID",
  "SARRAFPRO_LICENSE_REFERENCE",
  "SARRAFPRO_REDISTRIBUTION_ALLOWED",
  "SARRAFPRO_CONTRACT_VERSION",
] as const;

let saved: Record<string, string | undefined> = {};
let backend: LocalAuthBackend;
let ingestion: PriceIngestionService;
let sources: PriceSourceService;

const NOW = Date.now();
const nowIso = new Date(NOW).toISOString();

/** Kaynak denetimlerinde yorumlar sayılmaz. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function licenseAltinApi(): void {
  process.env.ALTINAPI_API_URL = "https://ornek-saglayici.invalid/v1/prices";
  process.env.ALTINAPI_API_KEY = "test-anahtari-gercek-degil";
  process.env.ALTINAPI_LICENSE_TIER = "SOZLESME-2026-001";
  process.env.ALTINAPI_REDISTRIBUTION_ALLOWED = "true";
  process.env.ALTINAPI_CONTRACT_VERSION = "generic-json-1";
}

function priceFixture(bid: string, ask: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify([
        { symbol: "GRAM_ALTIN", bid, ask, timestamp: new Date().toISOString(), currency: "TRY" },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  backend = new LocalAuthBackend({ inMemory: true });
  ingestion = new PriceIngestionService(backend);
  sources = new PriceSourceService(backend);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------

describe("1. makine (cron) ucu tarayıcı kimliği beklemez", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("https://ornek.invalid/api/cron/price-ingestion", { method: "POST", headers });
  }

  it("doğru secret ile CSRF çerezi OLMADAN yetkilendirilir", () => {
    expect(machineAuthorized(request({ authorization: "Bearer gizli" }), "gizli")).toBe(true);
    expect(machineAuthorized(request({ "x-cron-secret": "gizli" }), "gizli")).toBe(true);
  });

  it("yanlış secret reddedilir", () => {
    expect(machineAuthorized(request({ authorization: "Bearer yanlis" }), "gizli")).toBe(false);
    expect(machineAuthorized(request({ "x-cron-secret": "yanlis" }), "gizli")).toBe(false);
  });

  it("secret tanımsızsa uç kapalıdır (boş secret herkesi geçirmez)", () => {
    expect(machineAuthorized(request({ authorization: "Bearer " }), undefined)).toBe(false);
    expect(machineAuthorized(request({ "x-cron-secret": "" }), "")).toBe(false);
    expect(machineAuthorized(request({}), "gizli")).toBe(false);
  });

  it("koşum anahtarı dakikaya yuvarlanır: aynı dakikadaki tekrar çağrı aynı anahtarı üretir", () => {
    const a = machineRunKey("price-ingestion", Date.parse("2026-09-03T10:15:10.000Z"));
    const b = machineRunKey("price-ingestion", Date.parse("2026-09-03T10:15:59.000Z"));
    const c = machineRunKey("price-ingestion", Date.parse("2026-09-03T10:16:00.000Z"));
    expect(a.runKey).toBe(b.runKey);
    expect(a.runKey).not.toBe(c.runKey);
    expect(a.minuteIso).toBe("2026-09-03T10:15:00.000Z");
  });

  it("cron route'u apiRoute yerine machineRoute kullanır ve çerez yazmaz", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Yorumlar ayıklanır: denetlenen şey açıklama metni değil, çalışan koddur.
    const source = stripComments(
      readFileSync(join(process.cwd(), "src", "app", "api", "cron", "price-ingestion", "route.ts"), "utf8"),
    );
    expect(source).toContain("machineRoute");
    expect(source).not.toContain("apiRoute");
  });

  it("makine yolları proxy'de CSRF çerezi almaz", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const proxy = stripComments(readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8"));
    expect(proxy).toContain("MACHINE_PATHS");
    expect(proxy).toContain('"/api/cron/"');
  });

  it("normal mutation route'ları CSRF korumasını KORUR", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const path of [
      ["src", "app", "api", "transactions", "route.ts"],
      ["src", "app", "api", "price-sources", "route.ts"],
    ]) {
      const source = stripComments(readFileSync(join(process.cwd(), ...path), "utf8"));
      expect(source, path.join("/")).toContain("apiRoute");
      expect(source, path.join("/")).not.toContain("machineRoute");
    }
  });
});

// ---------------------------------------------------------------------------

describe("2. fiyat sıçrama devre kesicisi gerçek akışta çalışır", () => {
  async function enable(): Promise<void> {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, true);
  }

  it("önceki fiyata göre 10 kat sıçrama karantinaya alınır", async () => {
    await enable();
    const first = await ingestion.ingestProvider("altinapi", {
      runKey: "jump-1",
      fetchImpl: priceFixture("6000", "6050"),
    });
    expect(first.accepted).toBe(1);

    const second = await ingestion.ingestProvider("altinapi", {
      runKey: "jump-2",
      fetchImpl: priceFixture("60000", "60500"),
    });
    expect(second.quarantined.map((entry) => entry.code)).toContain("PRICE_JUMP");
    // Güncel fiyat ESKİ değerde kalır; şüpheli fiyat değerlemeye girmez.
    const quotes = await backend.currentPriceQuotes("altinapi");
    expect(quotes!.quotes[0]!.liquidationPrice).toBe("6000");
  });

  it("makul değişim kabul edilir", async () => {
    await enable();
    await ingestion.ingestProvider("altinapi", { runKey: "ok-1", fetchImpl: priceFixture("6000", "6050") });
    const second = await ingestion.ingestProvider("altinapi", {
      runKey: "ok-2",
      fetchImpl: priceFixture("6050", "6100"),
    });
    expect(second.quarantined).toHaveLength(0);
    const quotes = await backend.currentPriceQuotes("altinapi");
    expect(quotes!.quotes[0]!.liquidationPrice).toBe("6050");
  });

  it("ilk alımda önceki değer olmadığı için PRICE_JUMP uygulanmaz", async () => {
    await enable();
    const first = await ingestion.ingestProvider("altinapi", {
      runKey: "first",
      fetchImpl: priceFixture("60000", "60500"),
    });
    expect(first.quarantined).toHaveLength(0);
  });

  it("başka sağlayıcının fiyatı karşılaştırmaya karışmaz", async () => {
    await enable();
    await ingestion.ingestProvider("altinapi", { runKey: "a", fetchImpl: priceFixture("6000", "6050") });
    // Mock sağlayıcı da açılır ve çok farklı bir fiyat üretir.
    await backend.setPriceProviderFlags("mock", true, true);
    await ingestion.ingestProvider("mock", { runKey: "m" });
    const again = await ingestion.ingestProvider("altinapi", {
      runKey: "b",
      fetchImpl: priceFixture("6100", "6150"),
    });
    expect(again.quarantined).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("3. karantina kaydı kalıcıdır", () => {
  it("reddedilen kayıt ürün, sebep ve fiyatla saklanır", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, true);
    await ingestion.ingestProvider("altinapi", {
      runKey: "q-1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { symbol: "GRAM_ALTIN", bid: "6000", ask: "5000", timestamp: nowIso, currency: "TRY" },
          ]),
        )) as typeof fetch,
    });

    const rows = await backend.listPriceQuarantine("altinapi", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonicalProductId).toBe("gram-altin");
    expect(rows[0]!.rejectionCode).toBe("INVERTED_SPREAD");
    expect(rows[0]!.liquidationPrice).toBe("6000");
    expect(rows[0]!.mappingVersion).toBeTruthy();
  });

  it("aynı koşumda aynı kanonik ürün iki kez gelemez", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, true);
    const outcome = await ingestion.ingestProvider("altinapi", {
      runKey: "dup-1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { symbol: "GRAM_ALTIN", bid: "6000", ask: "6050", timestamp: nowIso, currency: "TRY" },
            { symbol: "GRAM", bid: "9999", ask: "9999", timestamp: nowIso, currency: "TRY" },
          ]),
        )) as typeof fetch,
    });
    expect(outcome.result?.quoteCount).toBe(1);
    const rows = await backend.listPriceQuarantine("altinapi", 10);
    // İkinci kayıt ya eşlenemez ya da yinelenen olarak reddedilir; sessizce
    // "son kayıt kazanır" davranışı OLMAZ.
    const quotes = await backend.currentPriceQuotes("altinapi");
    expect(quotes!.quotes).toHaveLength(1);
    expect(quotes!.quotes[0]!.liquidationPrice).toBe("6000");
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it("kapalı veya referans kaynak fiyat yazamaz", async () => {
    await ingestion.syncCatalog();
    await expect(
      backend.applyPriceIngestion("mock", "kapali", {
        status: "ok",
        safeErrorCode: null,
        latencyMs: 1,
        fetchedAt: nowIso,
        quotes: [],
        quarantined: [],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("4. adapter semantiği", () => {
  function quote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
    return {
      canonicalProductId: "gram-altin",
      providerId: "altinapi",
      upstreamSourceId: null,
      marketId: "turkiye-genel",
      liquidationPrice: "5000",
      replacementPrice: "5050",
      currency: "TRY",
      providerTimestamp: nowIso,
      timestampProvenance: "UPSTREAM",
      fetchedAt: nowIso,
      status: "ok",
      staleAfterMs: 5 * 60_000,
      rawPayloadHash: null,
      mappingVersion: "test-1",
      licenseReference: null,
      ingestionRunId: null,
      ...overrides,
    };
  }

  const context = {
    providerId: "altinapi" as const,
    marketId: "turkiye-genel" as const,
    knownProductIds: new Set(["gram-altin"]),
    now: NOW,
  };

  it("sağlayıcı zamanı yoksa gözlem zamanı fiyat zamanı sayılmaz ve quote reddedilir", () => {
    const verdict = evaluateQuote(quote({ providerTimestamp: null, timestampProvenance: "UNKNOWN" }), context);
    expect(verdict.ok).toBe(false);
    expect((verdict as { code: QuoteRejectionCode }).code).toBe("TIMESTAMP_PROVENANCE_UNKNOWN");
  });

  it("para birimi doğrulanmadan TRY kabul edilmez", async () => {
    licenseAltinApi();
    const provider = createProvider("altinapi")!;
    const snapshot = await provider.fetchSnapshot(["gram-altin"], {
      now: () => NOW,
      // generic-json-1 sözleşmesi para birimini ZORUNLU kılar.
      fetchImpl: (async () =>
        new Response(JSON.stringify([{ symbol: "GRAM_ALTIN", bid: "5000", ask: "5050", timestamp: nowIso }]))) as typeof fetch,
    });
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("yalnızca URL ve anahtar girilmesi taslak adapter'ı üretim adapter'ı yapmaz", () => {
    process.env.ALTINAPI_API_URL = "https://ornek.invalid/v1";
    process.env.ALTINAPI_API_KEY = "anahtar";
    process.env.ALTINAPI_LICENSE_TIER = "SOZ-1";
    process.env.ALTINAPI_REDISTRIBUTION_ALLOWED = "true";
    // Sözleşme sürümü beyan edilmedi.
    expect(createProvider("altinapi")!.licenseStatus()).toBe("NOT_CONFIGURED");

    // Doğrulanmamış bir sürüm beyan etmek de yetmez.
    process.env.ALTINAPI_CONTRACT_VERSION = "uydurma-surum";
    expect(createProvider("altinapi")!.licenseStatus()).toBe("NOT_CONFIGURED");

    process.env.ALTINAPI_CONTRACT_VERSION = "generic-json-1";
    expect(createProvider("altinapi")!.licenseStatus()).toBe("LICENSED");
  });

  it("Sarraf Pro için doğrulanmış sözleşme yoktur; beyan edilse bile açılmaz", () => {
    process.env.SARRAFPRO_API_URL = "https://ornek.invalid/v1";
    process.env.SARRAFPRO_API_KEY = "anahtar";
    process.env.SARRAFPRO_MARKET_ID = "kayseri";
    process.env.SARRAFPRO_LICENSE_REFERENCE = "SOZ-1";
    process.env.SARRAFPRO_REDISTRIBUTION_ALLOWED = "true";
    process.env.SARRAFPRO_CONTRACT_VERSION = "generic-json-1";
    expect(createProvider("sarraf-pro-kayseri")!.licenseStatus()).toBe("NOT_CONFIGURED");
  });

  it("çalışmayan XML/WebSocket yeteneği çalışan özellik gibi raporlanmaz", () => {
    const sarraf = PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providerId === "sarraf-pro-kayseri")!;
    expect(sarraf.capabilities).not.toContain("XML");
    expect(sarraf.advertisedCapabilities).toContain("XML");

    const altinapi = describeProvider("altinapi")!;
    expect(altinapi.capabilities).not.toContain("WEBSOCKET");
    expect(altinapi.advertisedCapabilities).toContain("WEBSOCKET");
    // REST ile çalışan adapter kalıcı worker gerektirmez.
    expect(altinapi.requiresPersistentWorker).toBe(false);
  });

  it("Sarraf Pro üretim eşlemesi tahmini sembol İÇERMEZ", async () => {
    const { SARRAFPRO_MAPPING } = await import("@/prices/providers/mappings");
    expect(Object.keys(SARRAFPRO_MAPPING)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("5. açık global varsayılan kaynak", () => {
  it("varsayılan yoksa ilk açık kaynak seçilmez", async () => {
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("mock", true, true);
    const user = await backend.createUser({
      username: "ayse",
      displayName: "Ayşe",
      temporaryPassword: "Kuyumcu7Defter",
      role: "user",
    });
    expect(await sources.resolveActiveProviderCode(userActor(user))).toBeNull();

    await backend.setDefaultPriceProvider("mock");
    expect(await sources.resolveActiveProviderCode(userActor(user))).toBe("mock");
  });

  it("kullanıcının kendi tercihi global varsayılandan etkilenmez", async () => {
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("mock", true, true);
    const user = await backend.createUser({
      username: "mehmet",
      displayName: "Mehmet",
      temporaryPassword: "Kuyumcu7Defter",
      role: "user",
    });
    await sources.selectSource(userActor(user), "mock", "test");
    await backend.setDefaultPriceProvider(null);
    // Varsayılan kaldırılsa bile kullanıcının seçimi durur.
    expect(await sources.resolveActiveProviderCode(userActor(user))).toBe("mock");
  });

  it("kapalı kaynak varsayılan yapılamaz ve kapatılınca varsayılanlıktan düşer", async () => {
    await ingestion.syncCatalog();
    await expect(backend.setDefaultPriceProvider("mock")).rejects.toThrow();
    await backend.setPriceProviderFlags("mock", true, true);
    await backend.setDefaultPriceProvider("mock");
    await backend.setPriceProviderFlags("mock", false, false);
    expect(await backend.defaultPriceProvider()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("6. TOTP replay koruması", () => {
  async function setupAdmin() {
    process.env.AUTH_MFA_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const admin = await backend.createUser({
      username: "yonetici",
      displayName: "Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    const mfa = new MfaService(backend);
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    return { admin, mfa, secret: enrollment.secret };
  }

  it("aynı kod ikinci kez kabul edilmez", async () => {
    const { admin, mfa, secret } = await setupAdmin();
    const code = totpCode(secret, Date.now());
    // Kurulum sırasında kullanılan kod zaten tüketilmiştir.
    await expect(mfa.verify(adminActor(admin), code)).rejects.toMatchObject({ status: 400 });
  });

  it("iki eşzamanlı doğrulamadan yalnızca biri başarılı olur", async () => {
    process.env.AUTH_MFA_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const admin = await backend.createUser({
      username: "yonetici2",
      displayName: "Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    const mfa = new MfaService(backend);
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    // Kurulumu bir önceki pencerenin koduyla tamamla ki güncel kod serbest kalsın.
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now() - 30_000));

    const code = totpCode(enrollment.secret, Date.now());
    const results = await Promise.allSettled([
      mfa.verify(adminActor(admin), code),
      mfa.verify(adminActor(admin), code),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("sıfırlama sayacı temizler; kullanıcı yeniden kurulum yapabilir", async () => {
    const { admin, mfa, secret } = await setupAdmin();
    await backend.deleteMfaCredential(admin.id);
    const again = await mfa.startEnrollment(adminActor(admin), admin.username);
    expect(again.secret).not.toBe("");
    await expect(mfa.confirmEnrollment(adminActor(admin), totpCode(again.secret, Date.now()))).resolves.toBeUndefined();
    expect(secret).not.toBe(again.secret);
  });
});

// ---------------------------------------------------------------------------

describe("7. KAYSARDER kurum adı", () => {
  it("resmî ad kullanılır; 'Kuyumcular Odası' geçmez", () => {
    const sarraf = PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providerId === "sarraf-pro-kayseri")!;
    expect(sarraf.attribution).toContain("Kayseri Sarraflar ve Kuyumcular Derneği");
    expect(sarraf.attribution).not.toContain("Kuyumcular Odası");
    expect(sarraf.technicalName).not.toContain("Kuyumcular Odası");
  });
});

// ---------------------------------------------------------------------------

describe("8. Sarraf TV ekran okuma mantığı", () => {
  const rows: RawScreenRow[] = [
    { label: "HAS", cells: { TEK_SUTUN: "6.878" } },
    { label: "ÇEYREK", cells: { ALIŞ: "10.850", SATIŞ: "11.450" } },
    { label: "YARIM", cells: { ALIŞ: "21.700", SATIŞ: "22.900" } },
    { label: "GREMSE", cells: { ALIŞ: "108.500", SATIŞ: "114.500" } },
    { label: "ATA - REŞAT LİRA", cells: { ALIŞ: "44.900", SATIŞ: "47.100" } },
    { label: "KÜLÇE GÜMÜŞ", cells: { ALIŞ: "95.370", SATIŞ: "105.079" } },
  ];

  it("Türkçe büyük harf başlıkları doğru küçültülür", () => {
    // Varsayılan toLowerCase() "ALIŞ" → "aliş" üretip eşleşmeyi bozardı.
    expect(classifyHeader("ALIŞ")).toBe("buy");
    expect(classifyHeader("SATIŞ")).toBe("sell");
    expect(screenLabelToProduct("YARIM")?.productId).toBe("yeni-yarim");
  });

  it("sayı biçimi belge düzeyinde belirlenir", () => {
    expect(detectNumberFormat(["10.850", "224.150", "6.878"])).toBe("tr");
    expect(parseScreenNumber("10.850", "tr")).toBe("10850");
    expect(parseScreenNumber("1.234,56", "tr")).toBe("1234.56");
    expect(parseScreenNumber("10.85", "ambiguous")).toBeNull();
  });

  it("alış/satış yönü sütun başlığından doğrulanır; tek sütunlu satır atlanır", () => {
    const result = extractQuotes(rows, "dom");
    const ceyrek = result.quotes.find((quote) => quote.canonicalProductId === "yeni-ceyrek")!;
    expect(ceyrek.rawBuyLabel).toBe("ALIŞ");
    expect(ceyrek.liquidationPrice).toBe("10850");
    expect(ceyrek.replacementPrice).toBe("11450");
    expect(Number(ceyrek.replacementPrice)).toBeGreaterThan(Number(ceyrek.liquidationPrice));
    expect(result.unresolved.map((row) => row.rawProductName)).toContain("HAS");
  });

  it("belirsiz veya katalog dışı satırlar tahmin edilmez", () => {
    const result = extractQuotes(rows, "dom");
    const reasons = new Map(result.unresolved.map((row) => [row.rawProductName, row.reason]));
    expect(reasons.get("ATA - REŞAT LİRA")).toBe("TEK_SATIRDA_İKİ_ÜRÜN");
    expect(reasons.get("KÜLÇE GÜMÜŞ")).toBe("ALTIN_DEĞİL");
  });

  it("yeni/eski ayrımı yazmayan satırlar CONVENTION olarak işaretlenir", () => {
    const result = extractQuotes(rows, "dom");
    expect(result.quotes.find((quote) => quote.canonicalProductId === "yeni-ceyrek")!.mappingConfidence).toBe(
      "CONVENTION",
    );
    expect(result.quotes.find((quote) => quote.canonicalProductId === "gremse-altin")!.mappingConfidence).toBe(
      "EXACT",
    );
  });

  it("ekranda satış < alış görünüyorsa satır düzeltilmez, atlanır", () => {
    const result = extractQuotes([{ label: "GREMSE", cells: { ALIŞ: "114.500", SATIŞ: "108.500" } }], "dom");
    expect(result.quotes).toHaveLength(0);
    expect(result.unresolved[0]!.reason).toBe("MAKAS_TERS");
  });

  it("çıkarılan JSON ekran metniyle birebir doğrulanır", () => {
    const result = extractQuotes(rows, "dom");
    expect(verifyAgainstScreenText(result.quotes, rows)).toEqual([]);
    // Ekran değeri değişirse uyuşmazlık YAKALANIR.
    const tampered = result.quotes.map((quote) => ({ ...quote, liquidationPrice: "1" }));
    expect(verifyAgainstScreenText(tampered, rows).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("9. deneysel ekran toplayıcısı", () => {
  const observation = {
    canonicalProductId: "yeni-ceyrek",
    mappingConfidence: "CONVENTION" as const,
    liquidationPrice: "10850",
    replacementPrice: "11450",
    observedAt: nowIso,
  };

  it("bayrak açık değilse çalışmaz", () => {
    const result = collectScreenQuotes({
      headers: ["ALIŞ", "SATIŞ"],
      observations: [observation],
      unresolved: [],
      captchaSeen: false,
      ingestionRunId: null,
    });
    expect(result.status).toBe("DISABLED");
    expect(result.quotes).toHaveLength(0);
  });

  it("üretim dağıtımında bayrak yok sayılır", () => {
    process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
    process.env.VERCEL_ENV = "production";
    expect(
      collectScreenQuotes({
        headers: ["ALIŞ", "SATIŞ"],
        observations: [observation],
        unresolved: [],
        captchaSeen: false,
        ingestionRunId: null,
      }).status,
    ).toBe("DISABLED");
  });

  it("CAPTCHA görülürse UNAVAILABLE/BLOCKED döner; aşma denenmez", () => {
    process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
    const result = collectScreenQuotes({
      headers: ["ALIŞ", "SATIŞ"],
      observations: [observation],
      unresolved: [],
      captchaSeen: true,
      ingestionRunId: null,
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.safeErrorCode).toBe("CAPTCHA_OR_INTERACTION_REQUIRED");
    expect(result.quotes).toHaveLength(0);
  });

  it("ekran imzası değişirse fail closed olur", () => {
    process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
    expect(screenSignatureValid(["FİYAT"], 3)).toBe(false);
    const result = collectScreenQuotes({
      headers: ["FİYAT"],
      observations: [observation],
      unresolved: [],
      captchaSeen: false,
      ingestionRunId: null,
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.quotes).toHaveLength(0);
  });

  it("veri türü deneysel etiketlenir ve sağlayıcı zamanı UYDURULMAZ", () => {
    process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
    const result = collectScreenQuotes({
      headers: ["ALIŞ", "SATIŞ"],
      observations: [observation],
      unresolved: [],
      captchaSeen: false,
      ingestionRunId: "run-1",
    });
    expect(result.status).toBe("OK");
    expect(result.dataKind).toBe("LIVE_SCREEN_EXPERIMENTAL");
    expect(result.quotes[0]!.providerTimestamp).toBeNull();
    expect(result.quotes[0]!.timestampProvenance).toBe("OBSERVED");
    expect(result.quotes[0]!.licenseReference).toBeNull();
  });

  it("deneysel toplayıcı üretim sağlayıcı kaydına eklenmemiştir", () => {
    expect(PROVIDER_DESCRIPTORS.some((descriptor) => descriptor.providerId.includes("screen"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("10. artefakt temizliği", () => {
  it("yol şablonu değişken parçaları maskeler", () => {
    expect(templatePath("/api/v1/prices/12345")).toBe("/api/v1/prices/{n}");
    expect(templatePath("/f/9a8b7c6d5e4f3a2b")).toBe("/f/{hex}");
  });

  it("hassas sorgu anahtarları maskelenir", () => {
    expect(safeQueryKeys("?code=383838&slug=kayseri")).toEqual(["code:(maskelendi)", "slug"]);
  });

  it("cookie/authorization/jwt izleri yakalanır", () => {
    expect(findForbiddenTraces("Cookie: a=b")).toContain("cookie");
    expect(findForbiddenTraces("authorization: Bearer abcdefghijkl")).toContain("authorization");
    expect(findForbiddenTraces("slug=kayseri")).toEqual([]);
  });
});
