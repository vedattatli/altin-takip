import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NormalizedQuote } from "@/prices/contract";
import { PROVIDER_DESCRIPTORS } from "@/prices/descriptors";
import { createProvider } from "@/prices/providers";
import {
  approvalAppliesToCurrentMapping,
  SARRAF_TV_SCREEN_MAPPING_VERSION,
} from "@/prices/providers/sarraf-tv-screen-mapping";
import { evaluateQuote, type QuoteRejectionCode } from "@/prices/quality";
import { PLAN_PROVIDER_CODES } from "@/prices/valuation-plan";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { PriceIngestionService } from "@/server/prices/ingestion-service";
import { PriceSourceService } from "@/server/prices/price-source-service";
import { ScreenWorkerService, SCREEN_PROVIDER_CODE, leaseTokenOf } from "@/server/prices/screen-worker-service";
import type { ScreenWorkerPayload } from "@/server/prices/types";
import {
  readWorkerHeaders,
  signWorkerRequest,
  sha256Hex,
  verifyWorkerSignature,
} from "@/server/security/worker-signature";
import { signRequest } from "../services/sarraf-screen-worker/src/signing";
import { userActor } from "./actors";

/**
 * SPRINT 3.2 — SARRAF TV KAYSERİ ÖZEL PİLOTU
 *
 * Denetlenenler: imzalı worker ucu, kira/fencing, deneysel erişim izin listesi,
 * eşleme onay modeli, gözlem zamanı politikası ve sağlayıcı kimliğinin ayrılığı.
 */

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "APP_DEPLOYMENT_ENV",
  "PRICE_EXPERIMENTAL_SARRAF_SCREEN",
  "PRICE_EXPERIMENTAL_PRIVATE_PILOT",
  "PRICE_SCREEN_WORKER_SECRET",
  "PRICE_ALLOW_MOCK_PROVIDER",
] as const;

const SECRET = "pilot-test-secret-gercek-degil";
const NOW = Date.now();
const nowIso = new Date(NOW).toISOString();

let saved: Record<string, string | undefined> = {};
let backend: LocalAuthBackend;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.APP_DEPLOYMENT_ENV = "private-pilot";
  process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
  process.env.PRICE_EXPERIMENTAL_PRIVATE_PILOT = "true";
  process.env.PRICE_SCREEN_WORKER_SECRET = SECRET;
  backend = new LocalAuthBackend({ inMemory: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headersOf(record: Record<string, string>): Request {
  return new Request("https://ornek.invalid/api/internal/price-worker/sarraf-screen", {
    method: "POST",
    headers: record,
  });
}

// ---------------------------------------------------------------------------

describe("1. worker HMAC imzası", () => {
  const body = JSON.stringify({ workerId: "w1", observations: [] });

  function validHeaders(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
    const base = {
      timestamp: nowIso,
      nonce: "nonce-1",
      bodySha256: sha256Hex(body),
      workerId: "w1",
    };
    return {
      "content-type": "application/json",
      "x-worker-id": base.workerId,
      "x-worker-timestamp": base.timestamp,
      "x-worker-nonce": base.nonce,
      "x-worker-body-sha256": base.bodySha256,
      "x-worker-signature": signWorkerRequest(base, SECRET),
      "x-worker-version": "1.0.0",
      ...overrides,
    };
  }

  it("doğru imza kabul edilir", () => {
    const result = verifyWorkerSignature(readWorkerHeaders(headersOf(validHeaders())), body, SECRET, NOW);
    expect(result.ok).toBe(true);
  });

  it("yanlış imza reddedilir", () => {
    const result = verifyWorkerSignature(
      readWorkerHeaders(headersOf(validHeaders({ "x-worker-signature": "0".repeat(64) }))),
      body,
      SECRET,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
  });

  it("gövde değiştirilirse reddedilir", () => {
    const result = verifyWorkerSignature(
      readWorkerHeaders(headersOf(validHeaders())),
      `${body} `,
      SECRET,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, code: "BODY_HASH_MISMATCH" });
  });

  it("60 saniyeden eski istek reddedilir", () => {
    const result = verifyWorkerSignature(readWorkerHeaders(headersOf(validHeaders())), body, SECRET, NOW + 120_000);
    expect(result).toMatchObject({ ok: false, code: "TIMESTAMP_OUT_OF_RANGE" });
  });

  it("secret tanımsızsa uç kapalıdır", () => {
    const result = verifyWorkerSignature(readWorkerHeaders(headersOf(validHeaders())), body, undefined, NOW);
    expect(result).toMatchObject({ ok: false, code: "MISSING_SECRET" });
  });

  it("worker imzası sunucu doğrulamasıyla BİREBİR uyumludur", () => {
    // İki taraf ayrı dosyalarda uygulanır (worker "server-only" içe aktaramaz).
    // Bu test, biri değişip diğeri unutulursa kırılır.
    const signed = signRequest({
      body,
      workerId: "w1",
      workerVersion: "1.0.0",
      secret: SECRET,
      leaseToken: "w1:2026-01-01T00:00:00.000Z",
      now: () => NOW,
    });
    const request = new Request("https://ornek.invalid/x", {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
    const result = verifyWorkerSignature(readWorkerHeaders(request), body, SECRET, NOW);
    expect(result.ok).toBe(true);
  });

  it("nonce ikinci kez kabul edilmez", async () => {
    expect(await backend.claimWorkerNonce("n-1", "w1")).toBe(true);
    expect(await backend.claimWorkerNonce("n-1", "w1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("2. worker kirası ve fencing", () => {
  it("aynı anda yalnızca bir worker kirayı tutar", async () => {
    const first = await backend.acquireWorkerLease(SCREEN_PROVIDER_CODE, "w1", 180);
    const second = await backend.acquireWorkerLease(SCREEN_PROVIDER_CODE, "w2", 180);
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
  });

  it("eski kira jetonuyla gelen gönderi reddedilir", async () => {
    const service = new ScreenWorkerService(backend, { now: () => NOW });
    const lease = await service.acquireLease("w1");
    expect(lease.held).toBe(true);

    const payload: ScreenWorkerPayload = {
      workerId: "w1",
      workerVersion: "1.0.0",
      browserVersion: "test",
      mappingVersion: "v",
      screenSignature: "sig",
      headers: ["ALIŞ", "SATIŞ"],
      observedAt: nowIso,
      captchaSeen: false,
      observations: [],
      unresolved: [],
      restartCount: 0,
    };
    const stale = await service.ingest(payload, "w1:1970-01-01T00:00:00.000Z", "run-1");
    expect(stale.failure).toBe("LEASE_TOKEN_STALE");
  });

  it("kirayı tutmayan worker yazamaz", async () => {
    const service = new ScreenWorkerService(backend, { now: () => NOW });
    await service.acquireLease("w1");
    const state = await service.leaseState();
    const payload: ScreenWorkerPayload = {
      workerId: "w2",
      workerVersion: "1.0.0",
      browserVersion: "test",
      mappingVersion: "v",
      screenSignature: "sig",
      headers: ["ALIŞ", "SATIŞ"],
      observedAt: nowIso,
      captchaSeen: false,
      observations: [],
      unresolved: [],
      restartCount: 0,
    };
    const result = await service.ingest(payload, leaseTokenOf(state) ?? "", "run-2");
    expect(result.failure).toBe("LEASE_NOT_HELD");
  });
});

// ---------------------------------------------------------------------------

describe("3. deneysel erişim izin listesi", () => {
  async function setup() {
    const ingestion = new PriceIngestionService(backend);
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags(SCREEN_PROVIDER_CODE, true, false);
    const admin = await backend.createUser({
      username: "yonetici",
      displayName: "Yönetici",
      temporaryPassword: "Yonetici7Kasa",
      role: "admin",
    });
    const user = await backend.createUser({
      username: "pilotcu",
      displayName: "Pilot",
      temporaryPassword: "Kuyumcu7Defter",
      role: "user",
    });
    return { admin, user, sources: new PriceSourceService(backend) };
  }

  /*
   * KULLANICI BAZLI İZİN LİSTESİ KALDIRILDI.
   *
   * Tek karar noktası yöneticinin `enabled` bayrağıdır. İkinci bir kapı
   * katmanı yalnızca arıza üretiyordu: izin verilmemiş kaynaktaki ürünler
   * sessizce fiyatsız kalıyor, kullanıcı uygulamayı bozuk sanıyordu.
   * Uygulamada herkese açık kayıt yok; hesapları yalnızca yönetici açar.
   */
  it("kaynak açıksa listede görünür ve seçilebilir", async () => {
    const { user, sources } = await setup();
    const options = await sources.listSelectableSources(userActor(user));
    expect(options.some((option) => option.providerCode === SCREEN_PROVIDER_CODE)).toBe(true);
    await expect(sources.selectSource(userActor(user), SCREEN_PROVIDER_CODE, "pilot")).resolves.toMatchObject({
      providerCode: SCREEN_PROVIDER_CODE,
    });
  });

  it("kaynak KAPALIYSA listede görünmez", async () => {
    const { user, sources } = await setup();
    await backend.setPriceProviderFlags(SCREEN_PROVIDER_CODE, false, false);
    const options = await sources.listSelectableSources(userActor(user));
    expect(options.some((option) => option.providerCode === SCREEN_PROVIDER_CODE)).toBe(false);
  });

  /*
   * SESSİZ FALLBACK YASAĞI KALDIRILMADI. İzin katmanı gitti ama "kaynak veri
   * vermiyorsa başkasına geçilmez" kuralı aynen duruyor: kaynak kapatılınca
   * açık olan BAŞKA bir kaynağın fiyatı kullanıcıya yazılmaz.
   */
  it("kaynak kapatılınca BAŞKA kaynağa sessizce geçilmez", async () => {
    const { user, sources } = await setup();
    await sources.selectSource(userActor(user), SCREEN_PROVIDER_CODE, "pilot");
    // Başka bir kaynak da açık olsun ki "sessizce ona geçmediği" görülsün.
    await backend.setPriceProviderFlags("mock", true, true);
    await backend.setDefaultPriceProvider("mock");

    await backend.setPriceProviderFlags(SCREEN_PROVIDER_CODE, false, false);
    const active = await sources.activeSnapshot(userActor(user));
    expect(active.source.providerCode).not.toBe("mock");
  });
});

// ---------------------------------------------------------------------------

describe("4. gözlem zamanı politikası", () => {
  function quote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
    return {
      canonicalProductId: "gremse-altin",
      providerId: "sarraf-tv-kayseri-screen",
      upstreamSourceId: "sarraf-tv-screen",
      marketId: "kayseri",
      liquidationPrice: "109000",
      replacementPrice: "114500",
      currency: "TRY",
      providerTimestamp: null,
      timestampProvenance: "OBSERVED",
      fetchedAt: nowIso,
      status: "ok",
      staleAfterMs: 120_000,
      rawPayloadHash: null,
      mappingVersion: "screen-1",
      licenseReference: null,
      ingestionRunId: null,
      ...overrides,
    };
  }

  const context = {
    providerId: "sarraf-tv-kayseri-screen" as const,
    marketId: "kayseri" as const,
    knownProductIds: new Set(["gremse-altin"]),
    now: NOW,
    observedTimePolicy: { providerId: "sarraf-tv-kayseri-screen" as const, maxObservationAgeMs: 120_000 },
  };

  it("taze gözlem kabul edilir", () => {
    expect(evaluateQuote(quote(), context).ok).toBe(true);
  });

  it("bayat gözlem reddedilir", () => {
    const verdict = evaluateQuote(quote({ fetchedAt: new Date(NOW - 5 * 60_000).toISOString() }), context);
    expect(verdict.ok).toBe(false);
    expect((verdict as { code: QuoteRejectionCode }).code).toBe("OBSERVATION_STALE");
  });

  it("politika açık olsa bile BAŞKA sağlayıcı zaman kuralını atlayamaz", () => {
    const verdict = evaluateQuote(
      quote({ providerId: "altinapi", marketId: "turkiye-genel" }),
      { ...context, providerId: "altinapi", marketId: "turkiye-genel" },
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as { code: QuoteRejectionCode }).code).toBe("TIMESTAMP_PROVENANCE_UNKNOWN");
  });

  it("gelecek zamanlı gözlem reddedilir", () => {
    const verdict = evaluateQuote(quote({ fetchedAt: new Date(NOW + 30 * 60_000).toISOString() }), context);
    expect(verdict.ok).toBe(false);
    expect((verdict as { code: QuoteRejectionCode }).code).toBe("TIMESTAMP_FUTURE");
  });
});

// ---------------------------------------------------------------------------

describe("5. sağlayıcı kimliği ve güvenlik yüzeyi", () => {
  it("deneysel kaynak resmî API sağlayıcısından ayrıdır ve lisanslı görünmez", () => {
    const screen = PROVIDER_DESCRIPTORS.find((d) => d.providerId === SCREEN_PROVIDER_CODE)!;
    expect(screen.technicalName).toContain("ekran gözlemi");
    expect(screen.capabilities).not.toContain("REDISTRIBUTION_LICENSED");
    expect(createProvider(SCREEN_PROVIDER_CODE)!.licenseStatus()).toBe("EXPERIMENTAL_PRIVATE");
  });

  /*
   * LİSANS DURUMU ORTAM AYARI DEĞİLDİR.
   *
   * Kaynağın yeniden yayım izni yoktur; bu her ortamda aynıdır. Eskiden ortam
   * bayrağı eksikse kaynak "NOT_CONFIGURED" görünüyordu — yani lisans beyanı
   * bir ayara bağlıydı. Ayar kalktı, beyan kaldı: kaynak her koşulda lisanssız
   * etiketlenir ve LİSANSLI SAYILMAZ.
   */
  it("lisans durumu ortamdan bağımsızdır ve LİSANSLI olmaz", () => {
    const env = process.env as Record<string, string | undefined>;
    for (const value of ["public-production", "production", undefined]) {
      if (value === undefined) delete env.APP_DEPLOYMENT_ENV;
      else env.APP_DEPLOYMENT_ENV = value;
      const status = createProvider(SCREEN_PROVIDER_CODE)!.licenseStatus();
      expect(status, String(value)).toBe("EXPERIMENTAL_PRIVATE");
      expect(status, String(value)).not.toBe("LICENSED");
    }
  });

  it("özel pilotta VERCEL_ENV=production kaynağı engellemez", () => {
    const env = process.env as Record<string, string | undefined>;
    env.VERCEL_ENV = "production";
    env.APP_DEPLOYMENT_ENV = "private-pilot";
    expect(createProvider(SCREEN_PROVIDER_CODE)!.licenseStatus()).toBe("EXPERIMENTAL_PRIVATE");
  });

  it("deneysel kaynak global varsayılan yapılamaz", async () => {
    const ingestion = new PriceIngestionService(backend);
    await ingestion.syncCatalog();
    await backend.setPriceProviderFlags(SCREEN_PROVIDER_CODE, true, false);
    await expect(backend.setDefaultPriceProvider(SCREEN_PROVIDER_CODE)).rejects.toThrow();
  });

  it("kaynak kendi başına veri çekmez; worker gerekir", async () => {
    const provider = createProvider(SCREEN_PROVIDER_CODE)!;
    const snapshot = await provider.fetchSnapshot(["gremse-altin"], { now: () => NOW });
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.safeErrorCode).toBe("EXTERNAL_WORKER_REQUIRED");
  });

  it("worker kaynağında service_role veya Supabase anahtarı bulunmaz", () => {
    const root = join(process.cwd(), "services", "sarraf-screen-worker");
    for (const file of ["src/index.ts", "src/screen-session.ts", "src/signing.ts", "Dockerfile"]) {
      // Yorumlar ayıklanır: denetlenen şey açıklama metni değil, çalışan koddur.
      const source = readFileSync(join(root, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*(\/\/|#).*$/gm, "");
      expect(source, file).not.toMatch(/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE|service_role/);
    }
  });

  it("worker Dockerfile'ı root dışı kullanıcı ve healthcheck tanımlar", () => {
    const dockerfile = readFileSync(join(process.cwd(), "services", "sarraf-screen-worker", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/USER pwuser/);
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/mcr\.microsoft\.com\/playwright/);
  });
});

// ---------------------------------------------------------------------------

describe("5b. lisanssız kaynak yönetim ekranından ETKİNLEŞTİRİLEBİLİR", () => {
  /*
   * ÜRETİMDE YAŞANDI: Kapalıçarşı kaynağı kapalı kaldı, gram altın fiyatsız
   * göründü ve yönetici kaynağı açamadı — "Etkinleştir" düğmesi sürekli devre
   * dışıydı. Sebep iki ayrı kavramın karışmasıydı:
   *
   *   selectable : kullanıcı GENEL listeden seçebilir mi?  (deneyselde HEP false)
   *   canEnable  : sistem bu kaynaktan fiyat ÇEKEBİLİR mi? (deneyselde true)
   *
   * Arayüz düğmeyi `selectable`e bakarak kapatıyordu. Sunucu ve veritabanı
   * kısıtı ise etkinleştirmeye izin veriyordu.
   */
  it("lisanssız kaynak hem seçilebilir hem etkinleştirilebilir", async () => {
    const ingestion = new PriceIngestionService(backend);
    await ingestion.syncCatalog();
    const rows = await new PriceSourceService(backend).adminProviderState();

    for (const code of PLAN_PROVIDER_CODES) {
      const row = rows.find((candidate) => candidate.code === code);
      expect(row, code).toBeDefined();
      expect(row?.licenseStatus, code).toBe("EXPERIMENTAL_PRIVATE");
      expect(row?.selectable, `${code}: kullanılabilir olmalı`).toBe(true);
      expect(row?.canEnable, `${code}: yönetici etkinleştirebilmeli`).toBe(true);
    }
  });

  it("lisanssız kaynak etkinleştirilemez", async () => {
    const ingestion = new PriceIngestionService(backend);
    await ingestion.syncCatalog();
    const rows = await new PriceSourceService(backend).adminProviderState();
    const licenseRequired = rows.filter((row) => row.licenseStatus === "LICENSE_REQUIRED");
    expect(licenseRequired.length).toBeGreaterThan(0);
    for (const row of licenseRequired) {
      expect(row.canEnable, row.code).toBe(false);
    }
  });
});

describe("6. worker ucu tarayıcı yüzeyinden ayrıdır", () => {
  it("proxy worker yoluna CSRF çerezi BASMAZ", async () => {
    // 3.1'de cron ucunda aynı hata vardı: middleware makine yanıtına çerez
    // ekliyordu. Bu test dosya içeriğini değil, gerçek proxy davranışını ölçer.
    process.env.AUTH_CSRF_SECRET = "test-csrf-secret-en-az-otuz-iki-karakter";
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");

    const machine = await proxy(
      new NextRequest("https://ornek.invalid/api/internal/price-worker/sarraf-screen", {
        method: "POST",
      }),
    );
    expect(machine.headers.get("set-cookie")).toBeNull();

    // Karşılaştırma: normal bir tarayıcı yolu çerezi ALMAYA devam eder.
    const browser = await proxy(new NextRequest("https://ornek.invalid/panel", { method: "GET" }));
    expect(browser.headers.get("set-cookie")).not.toBeNull();
  });

  it("worker route'ları apiRoute DEĞİL machineRoute kullanır", () => {
    for (const file of [
      "src/app/api/internal/price-worker/sarraf-screen/route.ts",
      "src/app/api/internal/price-worker/lease/route.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/apiRoute/);
      expect(source, file).toMatch(/verifyWorkerSignature/);
    }
  });
});

describe("7. yönetici onayı ve eşleme sürümü", () => {
  it("onay yalnızca GÜNCEL eşleme sürümünde geçerlidir", () => {
    expect(approvalAppliesToCurrentMapping(SARRAF_TV_SCREEN_MAPPING_VERSION, "yeni-ceyrek")).toBe(true);
    expect(approvalAppliesToCurrentMapping("bilinmeyen-surum", "yeni-ceyrek")).toBe(false);
    expect(approvalAppliesToCurrentMapping("", "yeni-ceyrek")).toBe(false);
  });

  /*
   * ÜRETİMDE YAŞANDI: onaylar sürüm 3'te alınmıştı, kod sürüm 4'e geçti.
   * Fiyat yolu onayları sessizce düşürdü, yönetim ekranı ise hepsini yeşil
   * "OPERATOR_VERIFIED" göstermeye devam etti. Yönetici "onaylı" görürken
   * ÇEYREK / YARIM / TAM fiyatsız kaldı ve sebebi hiçbir yerde yazmıyordu.
   *
   * Kural artık tek fonksiyondadır ve ekran da aynı karşılaştırmayı yapar.
   */
  it("fiyat yolu sürüm karşılaştırmasını satır içinde tekrar etmez", () => {
    const source = readFileSync(join(process.cwd(), "src/server/prices/screen-worker-service.ts"), "utf8");
    expect(source).toMatch(/approvalAppliesToCurrentMapping\(row\.mappingVersion, row\.canonicalProductId\)/);
    expect(source).not.toMatch(/row\.mappingVersion !== SARRAF_TV_SCREEN_MAPPING_VERSION/);
  });

  /*
   * Onay bir CÜMLEDİR: "ekranda ÇEYREK yazan satır, Yeni Çeyrek ürünüdür."
   * Sürüm 3'ten 4'e geçerken DEĞİŞEN TEK ŞEY ATA-REŞAT satırlarının
   * GROUPED_EXPLICIT olmasıydı; CONVENTION tablosu aynı kaldı. Bu yüzden o üç
   * ürün için sürüm 3'te verilmiş onay hâlâ aynı şeyi söyler ve geçerlidir.
   * Denklik tablosunda ADI GEÇMEYEN ürün için eski onay geçersizdir.
   */
  it("sürüm 3 onayı yalnızca eşlemesi değişmemiş ürünler için geçerlidir", () => {
    for (const productId of ["yeni-ceyrek", "yeni-yarim", "yeni-tam"]) {
      expect(approvalAppliesToCurrentMapping("sarraf-tv-screen-observed-3", productId), productId).toBe(true);
    }
    expect(approvalAppliesToCurrentMapping("sarraf-tv-screen-observed-3", "ata-altin")).toBe(false);
    expect(approvalAppliesToCurrentMapping("sarraf-tv-screen-observed-3", "gram-altin")).toBe(false);
    // Ürün verilmezse eski sürüm asla geçerli sayılmaz.
    expect(approvalAppliesToCurrentMapping("sarraf-tv-screen-observed-3")).toBe(false);
  });

  /*
   * ÜRETİMDE YAŞANDI (2026-09-04T05:26Z): sayfa yavaş açıldı, tablo yapısı
   * hazırdı ama fiyat hücreleri boştu. 12 satırın 12'si çözülemedi
   * (`products:0, unresolved:12`) ve bu BOŞ liste kaydedildi; panelde bütün
   * fiyatlar "—" oldu, uygulama bozuk göründü.
   *
   * Hiç ürün çözülememişse elde "fiyat yok" bilgisi değil HİÇ BİLGİ yoktur;
   * son iyi gözlem silinmez.
   */
  it("boş gözlem son iyi ekran satırlarının üstüne yazmaz", async () => {
    const service = new ScreenWorkerService(backend, { now: () => NOW });
    await backend.setScreenRows(
      SCREEN_PROVIDER_CODE,
      [
        {
          rawLabel: "ÇEYREK",
          buy: "10950",
          sell: "11500",
          single: null,
          canonicalProductId: "yeni-ceyrek",
          confidence: "OPERATOR_VERIFIED",
          usedInValuation: true,
          reason: null,
        },
      ],
      "sig",
      nowIso,
    );

    const lease = await service.acquireLease("w1");
    const payload: ScreenWorkerPayload = {
      workerId: "w1",
      workerVersion: "1.0.0",
      browserVersion: "test",
      mappingVersion: SARRAF_TV_SCREEN_MAPPING_VERSION,
      screenSignature: "sig",
      headers: ["ALIŞ", "SATIŞ"],
      observedAt: nowIso,
      captchaSeen: false,
      observations: [],
      unresolved: [
        { rawProductName: "ÇEYREK", reason: "SAYI_OKUNAMADI", observedValues: [] },
        { rawProductName: "YARIM", reason: "SAYI_OKUNAMADI", observedValues: [] },
      ],
      restartCount: 0,
    };
    await service.ingest(payload, lease.leaseToken ?? "", "run-empty");

    const stored = await backend.screenRows(SCREEN_PROVIDER_CODE);
    expect(stored?.rows).toHaveLength(1);
    expect(stored?.rows[0]).toMatchObject({ rawLabel: "ÇEYREK", buy: "10950", sell: "11500" });
  });

  /*
   * Onaylı satır ekranda "onay olmadan hesaba girmez" DİYEMEZ.
   *
   * ÜRETİMDE GÖRÜLDÜ: satır "7 satır değerlemeye giriyor" başlığının altında
   * dururken güven sütunu hâlâ ham CONVENTION yazıyordu — aynı satır hem
   * "giriyor" hem "girmiyor" diyordu. Kaydedilen güven, toplayıcının
   * kullandığı ETKİN güven olmalıdır.
   *
   * Not: tam `ingest` yolu burada koşturulamıyor; yerel test ikizi
   * EXPERIMENTAL_PRIVATE sağlayıcının fiyat yazmasına izin vermiyor, üretim
   * RPC'si veriyor. Bu ikizin kendi eksiği ve ayrıca ele alınmalı.
   */
  it("ekran satırına ETKİN güven yazılır, ham eşleme güveni değil", () => {
    const source = readFileSync(join(process.cwd(), "src/server/prices/screen-worker-service.ts"), "utf8");
    expect(source).toMatch(/confidence: approved\.get\(observation\.canonicalProductId\) \?\? observation\.mappingConfidence/);
  });

  it("yönetim ekranı eski sürümdeki onayı geçerli göstermez", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/admin-screen-source-view.tsx"), "utf8");
    // Sürüm karşılaştırması yapılıyor ve sonucu satırın görünümünü belirliyor.
    expect(source).toMatch(/row\.appliesToCurrentMapping === false/);
    expect(source).toMatch(/Geçersiz — eski eşleme sürümü/);
    expect(source).toMatch(/stale-approval-warning/);
  });
});
