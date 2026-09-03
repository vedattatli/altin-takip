import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { parseLedgerCommand } from "@/domain/accounting";
import { MfaService } from "@/server/auth/mfa-service";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { ProviderNotSelectableError } from "@/server/prices/types";
import { PriceIngestionService, ingestionIntervalMs } from "@/server/prices/ingestion-service";
import { PriceSourceService } from "@/server/prices/price-source-service";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { totpCode } from "@/server/auth/totp";
import { totpCode as e2eTotpCode } from "../e2e/totp";
import { TEST_OVERRIDE_TOKEN } from "@/auth/types";
import { devOnlyProviderBlocked } from "@/prices/dev-gate";
import { describeProvider } from "@/prices/registry";
import { adminActor, scopeOf, userActor } from "./actors";
import { buyCommand, sellCommand } from "./helpers";

/**
 * SPRINT 3 — KAYNAK SEÇİMİ, INGESTION, SESSİZ FALLBACK YASAĞI VE ADMIN MFA
 *
 * Yerel arka uç, Supabase RPC'leriyle AYNI kuralları uygular; bu testler o
 * sözleşmeyi doğrular. Gerçek sağlayıcıya bağlanılmaz.
 */

let backend: LocalAuthBackend;
let ingestion: PriceIngestionService;
let sources: PriceSourceService;
let portfolio: UserPortfolioService;
let user: UserProfile;
let other: UserProfile;

const ENV_KEYS = [
  "ALTINAPI_API_URL",
  "ALTINAPI_API_KEY",
  "ALTINAPI_LICENSE_TIER",
  "ALTINAPI_REDISTRIBUTION_ALLOWED",
  "AUTH_MFA_ENCRYPTION_KEY",
  "PRICE_MOCK_UNAVAILABLE_PRODUCTS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

function licenseAltinApi(): void {
  process.env.ALTINAPI_API_URL = "https://ornek-saglayici.invalid/v1/prices";
  process.env.ALTINAPI_API_KEY = "test-anahtari";
  process.env.ALTINAPI_LICENSE_TIER = "SOZLESME-2026-001";
  process.env.ALTINAPI_REDISTRIBUTION_ALLOWED = "true";
}

/**
 * Zaman: fiyat tazeliği hem serviste hem arka uçta denetlendiğinden testler
 * GERÇEK saati kullanır; fiyat fixture'ları "şimdi" damgalıdır. Böylece bayatlık
 * kuralı gerçek üretim davranışıyla aynı şekilde çalışır.
 */
const NOW = Date.now();

function priceFixture(price = "5000"): typeof fetch {
  return (async () => {
    const stamp = new Date().toISOString();
    return new Response(
      JSON.stringify([
        { symbol: "GRAM_ALTIN", bid: price, ask: String(Number(price) + 50), timestamp: stamp },
        { symbol: "CEYREK_YENI", bid: "11000", ask: "11300", timestamp: stamp },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  backend = new LocalAuthBackend({ inMemory: true });
  ingestion = new PriceIngestionService(backend);
  sources = new PriceSourceService(backend);
  portfolio = new UserPortfolioService(backend);
  user = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe",
    temporaryPassword: "Kuyumcu7Defter",
    role: "user",
  });
  other = await backend.createUser({
    username: "mehmet",
    displayName: "Mehmet",
    temporaryPassword: "Kuyumcu7Defter",
    role: "user",
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function enableAltinApi(): Promise<void> {
  licenseAltinApi();
  await ingestion.syncCatalog();
  await backend.setPriceProviderFlags("altinapi", true, true);
}

describe("1. katalog eşitleme ve yönetici bayrakları", () => {
  it("katalog idempotenttir; lisanssız kaynak etkinleştirilemez", async () => {
    await ingestion.syncCatalog();
    const first = await backend.listPriceProviders();
    await ingestion.syncCatalog();
    expect((await backend.listPriceProviders()).length).toBe(first.length);
    await expect(backend.setPriceProviderFlags("altinapi", true, true)).rejects.toBeInstanceOf(
      ProviderNotSelectableError,
    );
    await expect(backend.setPriceProviderFlags("harem-direct", true, true)).rejects.toBeInstanceOf(
      ProviderNotSelectableError,
    );
  });

  it("lisans kaybedilirse kaynak otomatik kapanır (fail closed)", async () => {
    await enableAltinApi();
    expect((await backend.listPriceProviders()).find((p) => p.code === "altinapi")!.enabled).toBe(true);
    delete process.env.ALTINAPI_REDISTRIBUTION_ALLOWED;
    await ingestion.syncCatalog();
    const provider = (await backend.listPriceProviders()).find((p) => p.code === "altinapi")!;
    expect(provider.enabled).toBe(false);
    expect(provider.userSelectable).toBe(false);
  });

  it("kapalı kaynak kullanıcıya sunulamaz", async () => {
    await ingestion.syncCatalog();
    await expect(backend.setPriceProviderFlags("mock", false, true)).rejects.toBeInstanceOf(
      ProviderNotSelectableError,
    );
  });

  it("katalog hiç eşitlenmemişken de kaynak okuma/seçme çalışır", async () => {
    // Yönetim sayfası hiç açılmamış yeni kurulum: giriş noktaları katalogu kendisi hazırlar.
    expect(await backend.listPriceProviders()).toHaveLength(0);
    const options = await sources.listSelectableSources(userActor(user));
    expect(options).toEqual([]);
    expect((await backend.listPriceProviders()).length).toBeGreaterThan(0);

    // Aynı senaryo yönetici bayrağı için: satır yoksa "bilinmeyen sağlayıcı" hatası verilmez.
    const fresh = new LocalAuthBackend({ inMemory: true });
    const freshSources = new PriceSourceService(fresh);
    await new PriceIngestionService(fresh).ensureCatalog();
    await expect(fresh.setPriceProviderFlags("mock", true, true)).resolves.toBeTruthy();
    const state = await freshSources.adminProviderState();
    expect(state.find((row) => row.code === "mock")?.enabled).toBe(true);
  });

  it("test sağlayıcısı üretimde kapalıdır; yalnızca test kaçış kapısıyla açılır", async () => {
    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    const savedOverride = env.AUTH_ALLOW_LOCAL_BACKEND;
    try {
      env.NODE_ENV = "production";
      delete env.AUTH_ALLOW_LOCAL_BACKEND;
      expect(devOnlyProviderBlocked()).toBe(true);
      expect(describeProvider("mock")?.selectable).toBe(false);

      // Playwright üretim derlemesine karşı koşar; oradaki kaçış kapısı test sağlayıcısını açar.
      env.AUTH_ALLOW_LOCAL_BACKEND = TEST_OVERRIDE_TOKEN;
      expect(devOnlyProviderBlocked()).toBe(false);
      expect(describeProvider("mock")?.selectable).toBe(true);

      // Yanlış belirteç kapıyı açmaz.
      env.AUTH_ALLOW_LOCAL_BACKEND = "baska-bir-deger";
      expect(devOnlyProviderBlocked()).toBe(true);
    } finally {
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
      if (savedOverride === undefined) delete env.AUTH_ALLOW_LOCAL_BACKEND;
      else env.AUTH_ALLOW_LOCAL_BACKEND = savedOverride;
    }
  });

  it("başarısız katalog eşitlemesi önbelleğe alınmaz", async () => {
    const failing = new LocalAuthBackend({ inMemory: true });
    const service = new PriceIngestionService(failing);
    const original = failing.syncPriceProviders.bind(failing);
    let calls = 0;
    failing.syncPriceProviders = async (payload) => {
      calls += 1;
      if (calls === 1) throw new Error("gecici hata");
      return original(payload);
    };
    await expect(service.ensureCatalog()).rejects.toThrow("gecici hata");
    await expect(service.ensureCatalog()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("2. ingestion: idempotent, kilitli, karantinalı", () => {
  it("aynı koşum anahtarı iki kez uygulanmaz (duplicate history yok)", async () => {
    await enableAltinApi();
    const first = await ingestion.ingestProvider("altinapi", {
      runKey: "run-1",
      fetchImpl: priceFixture(),
      now: () => NOW,
    });
    expect(first.result!.skipped).toBe(false);
    expect(first.accepted).toBe(2);
    const second = await ingestion.ingestProvider("altinapi", {
      runKey: "run-1",
      fetchImpl: priceFixture(),
      now: () => NOW,
    });
    expect(second.result!.replayed).toBe(true);
    expect(second.result!.runId).toBe(first.result!.runId);
    const quotes = await backend.currentPriceQuotes("altinapi");
    expect(quotes!.quotes).toHaveLength(2);
  });

  it("şüpheli quote karantinaya alınır ve güncel fiyata girmez", async () => {
    await enableAltinApi();
    const bad = (async () =>
      new Response(
        JSON.stringify([
          { symbol: "GRAM_ALTIN", bid: "5000", ask: "4000", timestamp: new Date(NOW).toISOString() },
          { symbol: "CEYREK_YENI", bid: "11000", ask: "11300", timestamp: new Date(NOW).toISOString() },
        ]),
      )) as typeof fetch;
    const outcome = await ingestion.ingestProvider("altinapi", { runKey: "run-q", fetchImpl: bad });
    expect(outcome.quarantined.map((entry) => entry.code)).toContain("INVERTED_SPREAD");
    const quotes = await backend.currentPriceQuotes("altinapi");
    expect(quotes!.quotes.map((quote) => quote.canonicalProductId)).toEqual(["yeni-ceyrek"]);
  });

  it("yapılandırılmamış sağlayıcı çekilmez ve veri iddiasında bulunulmaz", async () => {
    await ingestion.syncCatalog();
    const outcome = await ingestion.ingestProvider("sarraf-pro-kayseri", {});
    expect(outcome.attempted).toBe(false);
    expect(outcome.safeErrorCode).toBe("NOT_CONFIGURED");
    expect(await backend.currentPriceQuotes("sarraf-pro-kayseri")).toMatchObject({ quotes: [] });
  });

  it("zamanlanmış alım yalnızca etkin kaynakları çeker; referans kaynağı atlanır", async () => {
    await enableAltinApi();
    const outcomes = await ingestion.ingestEnabled({ fetchImpl: priceFixture() });
    expect(outcomes.map((outcome) => outcome.providerCode)).toEqual(["altinapi"]);
  });

  it("alım aralığı 15 sn – 5 dk arasına sıkıştırılır", () => {
    const previous = process.env.PRICE_INGESTION_INTERVAL_MS;
    try {
      process.env.PRICE_INGESTION_INTERVAL_MS = "1000";
      expect(ingestionIntervalMs()).toBe(15_000);
      process.env.PRICE_INGESTION_INTERVAL_MS = "999999";
      expect(ingestionIntervalMs()).toBe(300_000);
      delete process.env.PRICE_INGESTION_INTERVAL_MS;
      expect(ingestionIntervalMs()).toBe(60_000);
    } finally {
      if (previous === undefined) delete process.env.PRICE_INGESTION_INTERVAL_MS;
      else process.env.PRICE_INGESTION_INTERVAL_MS = previous;
    }
  });
});

describe("3. kaynak seçimi ve izolasyon", () => {
  it("kullanıcı yalnızca yöneticinin açtığı kaynağı seçebilir", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, false);
    await expect(sources.selectSource(userActor(user), "altinapi", "deneme")).rejects.toMatchObject({ status: 409 });
    await backend.setPriceProviderFlags("altinapi", true, true);
    const result = await sources.selectSource(userActor(user), "altinapi", "deneme");
    expect(result.changed).toBe(true);
  });

  it("referans kaynağı seçilemez", async () => {
    await ingestion.syncCatalog();
    await expect(sources.selectSource(userActor(user), "bist-reference", "x")).rejects.toMatchObject({ status: 409 });
  });

  it("kullanıcı başka kullanıcının tercihini değiştiremez; tercihler ayrıdır", async () => {
    await enableAltinApi();
    await sources.selectSource(userActor(user), "altinapi", "seçim");
    expect((await backend.getPricePreference(scopeOf(user))).providerCode).toBe("altinapi");
    expect((await backend.getPricePreference(scopeOf(other))).providerCode).toBeNull();
    // Servis yalnızca kendi kapsamını üretir; hedef kullanıcı kimliği alınmaz.
    expect(sources.selectSource.length).toBe(3);
  });

  it("kaynak değişimi denetim olayı üretir; aynı kaynağa tekrar seçim olay üretmez", async () => {
    await enableAltinApi();
    await sources.selectSource(userActor(user), "altinapi", "ilk");
    const again = await sources.selectSource(userActor(user), "altinapi", "tekrar");
    expect(again.changed).toBe(false);
    const events = await sources.listSourceEvents(userActor(user));
    expect(events).toHaveLength(1);
    expect(events[0]!.newProviderCode).toBe("altinapi");
    expect(events[0]!.changedByRole).toBe("user");
  });
});

describe("4. sessiz fallback yasağı ve muhasebe bütünlüğü", () => {
  it("aktif kaynak veri vermiyorsa BAŞKA kaynağa geçilmez; değerleme yapılmaz", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    // İki kaynak da açık; aktif kaynak (altinapi) boş, mock dolu.
    await backend.setPriceProviderFlags("altinapi", true, true);
    await backend.setPriceProviderFlags("mock", true, true);
    await ingestion.ingestProvider("mock", { runKey: "mock-1" });
    await sources.selectSource(userActor(user), "altinapi", "seçim");

    await portfolio.appendTransaction(userActor(user), buyCommand({ quantity: "2" }));
    const summary = await portfolio.getSummary(userActor(user));
    expect(summary.priceSource?.providerCode).toBe("altinapi");
    expect(summary.valuationStatus).toBe("none");
    expect(summary.totalLiquidationValue).toBe("0");
    expect(summary.totalRemainingCostBasis).toBe("10000");
  });

  it("kaynak değişimi geçmiş maliyetleri ve gerçekleşmiş K/Z'yi DEĞİŞTİRMEZ; yalnızca gerçekleşmemiş K/Z değişir", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, true);
    await backend.setPriceProviderFlags("mock", true, true);
    await ingestion.ingestProvider("altinapi", { runKey: "a-1", fetchImpl: priceFixture("5000") });
    await ingestion.ingestProvider("mock", { runKey: "m-1" });

    await sources.selectSource(userActor(user), "altinapi", "ilk");
    await portfolio.appendTransaction(userActor(user), buyCommand({ quantity: "4", unitPrice: "4800" }));
    await portfolio.appendTransaction(userActor(user), sellCommand({ quantity: "1", unitPrice: "5200" }));

    const before = await portfolio.getSummary(userActor(user));
    const ledgerBefore = await portfolio.listLedger(userActor(user));

    await sources.selectSource(userActor(user), "mock", "karşılaştırma sonrası");
    const after = await portfolio.getSummary(userActor(user));
    const ledgerAfter = await portfolio.listLedger(userActor(user));

    // Defter ve gerçekleşmiş sonuç birebir aynı kalır.
    expect(JSON.stringify(ledgerAfter)).toBe(JSON.stringify(ledgerBefore));
    expect(after.totalRealizedPnl).toBe(before.totalRealizedPnl);
    expect(after.totalRemainingCostBasis).toBe(before.totalRemainingCostBasis);
    expect(after.priceSource?.providerCode).toBe("mock");
    // Yalnızca güncel değerleme (dolayısıyla gerçekleşmemiş K/Z) kaynağa bağlıdır.
    expect(after.totalUnrealizedPnl).not.toBe(before.totalUnrealizedPnl);
  });

  it("MARKET_BASELINE snapshot'ı kaynak değişince değişmez", async () => {
    licenseAltinApi();
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags("altinapi", true, true);
    await backend.setPriceProviderFlags("mock", true, true);
    await ingestion.ingestProvider("altinapi", { runKey: "a-1", fetchImpl: priceFixture("5000") });
    await sources.selectSource(userActor(user), "altinapi", "ilk");

    const opening = await portfolio.appendTransaction(userActor(user), {
      kind: "OPENING_BALANCE",
      productId: "gram-altin",
      quantity: "2",
      costMethod: "MARKET_BASELINE",
    });
    const snapshotBefore = JSON.stringify(opening.entry.priceSnapshot);

    await sources.selectSource(userActor(user), "mock", "değişim");
    const ledger = await portfolio.listLedger(userActor(user));
    const entry = ledger.find((row) => row.id === opening.entry.id)!;
    expect(JSON.stringify(entry.priceSnapshot)).toBe(snapshotBefore);
    expect(entry.totalPaid).toBe(opening.entry.totalPaid);
  });

  it("karşılaştırma ekranı değerleme kaynağını değiştirmez", async () => {
    await enableAltinApi();
    await backend.setPriceProviderFlags("mock", true, true);
    await ingestion.ingestProvider("altinapi", { runKey: "a-1", fetchImpl: priceFixture() });
    await ingestion.ingestProvider("mock", { runKey: "m-1" });
    await sources.selectSource(userActor(user), "altinapi", "ilk");

    const before = await sources.resolveActiveProviderCode(userActor(user));
    const compare = await sources.compareSources(userActor(user));
    expect(compare.providers.length).toBeGreaterThan(1);
    expect(compare.activeProviderCode).toBe("altinapi");
    expect(await sources.resolveActiveProviderCode(userActor(user))).toBe(before);
  });
});

describe("4b. üretimde test verisine sessiz düşüş yoktur", () => {
  it("kaynak seçili değilken üretimde MARKET_BASELINE oluşmaz", async () => {
    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    const savedOverride = env.AUTH_ALLOW_LOCAL_BACKEND;
    try {
      // Geliştirme ortamı: test sağlayıcısı kolaylık olsun diye devrededir.
      const devBaseline = await portfolio.baselineSnapshotFor("gram-altin", userActor(user));
      expect(devBaseline).not.toBeNull();
      expect(devBaseline?.isRealMarketData).toBe(false);

      // Üretim: hiçbir kaynak seçili değilken test fiyatı KULLANILMAZ.
      env.NODE_ENV = "production";
      delete env.AUTH_ALLOW_LOCAL_BACKEND;
      const snapshot = await portfolio.currentSnapshot(userActor(user));
      expect(snapshot.status).toBe("unavailable");
      expect(Object.keys(snapshot.quotes)).toHaveLength(0);
      expect(snapshot.provider.isRealMarketData).toBe(false);
      expect(snapshot.provider.id).not.toBe("mock");
      expect(await portfolio.baselineSnapshotFor("gram-altin", userActor(user))).toBeNull();

      // Aktör verilmese de üretimde test verisi dönmez.
      expect((await portfolio.currentSnapshot()).status).toBe("unavailable");
    } finally {
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
      if (savedOverride === undefined) delete env.AUTH_ALLOW_LOCAL_BACKEND;
      else env.AUTH_ALLOW_LOCAL_BACKEND = savedOverride;
    }
  });
});

describe("5. yönetici ikinci faktörü", () => {
  let admin: UserProfile;
  let mfa: MfaService;

  beforeEach(async () => {
    process.env.AUTH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    admin = await backend.createUser({
      username: "yonetici",
      displayName: "Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    mfa = new MfaService(backend);
  });

  it("kurulum tamamlanmadan yönetim işlemleri reddedilir", async () => {
    await expect(mfa.assertSessionSatisfiesMfa(admin, null)).rejects.toMatchObject({ status: 403 });
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrollment.recoveryCodes).toHaveLength(10);
    // Onaylanmadan hâlâ reddedilir.
    await expect(mfa.assertSessionSatisfiesMfa(admin, null)).rejects.toMatchObject({ status: 403 });

    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    await expect(mfa.assertSessionSatisfiesMfa(admin, new Date().toISOString())).resolves.toBeUndefined();
    // Oturumda doğrulanmadıysa yine reddedilir.
    await expect(mfa.assertSessionSatisfiesMfa(admin, null)).rejects.toMatchObject({ status: 403 });
  });

  it("normal kullanıcı için ikinci faktör zorunlu değildir", async () => {
    expect(MfaService.isRequiredFor(user)).toBe(false);
    await expect(mfa.assertSessionSatisfiesMfa(user, null)).resolves.toBeUndefined();
  });

  it("kurtarma kodu tek kullanımlıktır ve özet olarak saklanır", async () => {
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    const code = enrollment.recoveryCodes[0]!;
    expect(await mfa.verify(adminActor(admin), code)).toEqual({ usedRecoveryCode: true });
    await expect(mfa.verify(adminActor(admin), code)).rejects.toMatchObject({ status: 400 });
    expect(await backend.countRecoveryCodes(admin.id)).toBe(9);
    // Depoda kodun kendisi bulunmaz.
    expect(JSON.stringify(backend)).not.toContain(code.replace(/-/g, ""));
  });

  it("yanlış kod reddedilir; art arda hatada kilitlenir", async () => {
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(mfa.verify(adminActor(admin), "000000")).rejects.toMatchObject({ status: 400 });
    }
    await expect(mfa.verify(adminActor(admin), "000000")).rejects.toMatchObject({ status: 429 });
  });

  it("secret düz metin saklanmaz; sıfırlama açık onay ister ve oturumları düşürür", async () => {
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    const credential = await backend.getMfaCredential(admin.id);
    expect(credential!.secretCiphertext).not.toContain(enrollment.secret);
    expect(JSON.stringify(backend)).not.toContain(enrollment.secret);

    const target = await backend.createUser({
      username: "yonetici2",
      displayName: "İkinci Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    await new MfaService(backend).startEnrollment(adminActor(target), target.username);
    await expect(mfa.resetForUser(adminActor(admin), target.id, "yanlis")).rejects.toMatchObject({ status: 400 });
    await mfa.resetForUser(adminActor(admin), target.id, "yonetici2");
    expect(await backend.getMfaCredential(target.id)).toBeNull();
  });

  it("parola değişikliği ikinci faktörü sessizce kaldırmaz", async () => {
    const enrollment = await mfa.startEnrollment(adminActor(admin), admin.username);
    await mfa.confirmEnrollment(adminActor(admin), totpCode(enrollment.secret, Date.now()));
    await backend.setPassword(admin.id, "YeniParola7Kasa");
    const credential = await backend.getMfaCredential(admin.id);
    expect(credential?.confirmedAt).toBeTruthy();
  });

  it("E2E üreteci sunucu üretecinin aynısını verir", () => {
    // e2e/totp.ts sunucu modülünü içe aktaramaz (server-only). Algoritma eşliğini
    // burada doğrularız; sapma olursa Playwright girişleri sessizce bozulmaz.
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    for (const at of [0, 1_000_000_000_000, 1_767_000_000_000, 2_000_000_030_000]) {
      expect(e2eTotpCode(secret, at)).toBe(totpCode(secret, at));
    }
    // RFC 6238 referans vektörü (ASCII "12345678901234567890" → base32).
    expect(e2eTotpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });
});

describe("6. komut sözleşmesi korunur", () => {
  it("kaynak değişimi defter komut doğrulamasını etkilemez", () => {
    const parsed = parseLedgerCommand(buyCommand({ quantity: "1" }));
    expect(parsed.ok).toBe(true);
  });
});
