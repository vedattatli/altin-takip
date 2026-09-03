import { createServer } from "node:http";

import { chromium, type Browser } from "playwright-core";

import { SARRAF_TV_SCREEN_MAPPING_VERSION } from "../../../src/prices/providers/sarraf-tv-screen-mapping";
import { ScreenSession } from "./screen-session";
import {
  backoffMs,
  healthyForPlatform,
  numberFromEnv,
  restartReason,
  stringFromEnv,
  type HealthStatus,
} from "./policy";
import { signRequest } from "./signing";

/**
 * SARRAF TV KAYSERİ EKRAN WORKER'I (DENEYSEL, ÖZEL PİLOT)
 *
 * Ayrı ve SÜREKLİ çalışan bir süreçtir. Vercel fonksiyonu içinde çalıştırılmaz:
 * kalıcı bir Chromium oturumu istek ömrüne sığmaz.
 *
 * Kurallar:
 *  - Tek tarayıcı süreci açık tutulur; her turda açılıp kapanmaz.
 *  - Supabase service_role anahtarı BULUNMAZ; yalnızca imzalı makine ucuna yazar.
 *  - CAPTCHA/etkileşim gerekirse fiyat GÖNDERMEZ (fail closed).
 *  - Ekran imzası değişirse fiyat GÖNDERMEZ.
 *  - Ağ kesilirse eski fiyat yeniymiş gibi gönderilmez; gözlem zamanı gerçek
 *    okuma anıdır ve sunucu tarafında bayatlık ayrıca denetlenir.
 *  - Cookie, token veya başlık LOGLANMAZ.
 *  - SIGTERM/SIGINT ile düzgün kapanır.
 */

const WORKER_VERSION = "1.0.0";
const PROVIDER_CODE = "sarraf-tv-kayseri-screen";

interface Config {
  appUrl: string;
  secret: string;
  workerId: string;
  targetUrl: string;
  intervalMs: number;
  healthPort: number;
  browserMaxAgeMs: number;
  memoryLimitMb: number;
}

/**
 * Eksik yapılandırma hatası. `variable` yalnızca DEĞİŞKEN ADIDIR; değeri
 * taşımaz, böylece log'a secret düşmez ama operatör neyin eksik olduğunu görür.
 */
class ConfigError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} tanımlı değil veya geçersiz.`);
    this.name = "ConfigError";
  }
}

function readConfig(): Config {
  const appUrl = (process.env.APP_BASE_URL ?? "").trim().replace(/\/$/u, "");
  const secret = (process.env.PRICE_SCREEN_WORKER_SECRET ?? "").trim();
  const workerId = stringFromEnv("WORKER_ID", "sarraf-screen-1");
  const targetUrl = (process.env.SARRAF_SCREEN_URL ?? "").trim();
  if (appUrl === "") throw new ConfigError("APP_BASE_URL");
  if (secret === "") throw new ConfigError("PRICE_SCREEN_WORKER_SECRET");
  if (targetUrl === "") throw new ConfigError("SARRAF_SCREEN_URL");
  if ((process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN ?? "").toLowerCase() !== "true") {
    throw new ConfigError("PRICE_EXPERIMENTAL_SARRAF_SCREEN");
  }
  return {
    appUrl,
    secret,
    workerId,
    targetUrl,
    intervalMs: Math.max(30_000, numberFromEnv("OBSERVE_INTERVAL_MS", 60_000, 1)),
    healthPort: numberFromEnv("PORT", 8080, 1),
    browserMaxAgeMs: Math.max(30 * 60_000, numberFromEnv("BROWSER_MAX_AGE_MS", 6 * 60 * 60_000, 1)),
    memoryLimitMb: Math.max(256, numberFromEnv("MEMORY_LIMIT_MB", 900, 1)),
  };
}

interface Health {
  status: HealthStatus;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  resolvedCount: number;
  unresolvedCount: number;
  captchaSeen: boolean;
  restartCount: number;
  leaseHeld: boolean;
  browserVersion: string | null;
  workerVersion: string;
  updateLagMs: number | null;
}

const health: Health = {
  status: "starting",
  lastSuccessAt: null,
  lastErrorCode: null,
  resolvedCount: 0,
  unresolvedCount: 0,
  captchaSeen: false,
  restartCount: 0,
  leaseHeld: false,
  browserVersion: null,
  workerVersion: WORKER_VERSION,
  updateLagMs: null,
};

/** Yalnızca güvenli alanlar loglanır: secret, cookie ve başlık ASLA. */
function log(event: string, detail: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

async function post(config: Config, path: string, body: unknown, leaseToken: string | null): Promise<Response> {
  const payload = JSON.stringify(body);
  const signed = signRequest({
    body: payload,
    workerId: config.workerId,
    workerVersion: WORKER_VERSION,
    secret: config.secret,
    leaseToken,
  });
  return fetch(`${config.appUrl}${path}`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(20_000),
  });
}

async function acquireLease(config: Config): Promise<string | null> {
  try {
    const response = await post(config, "/api/internal/price-worker/lease", { providerCode: PROVIDER_CODE }, null);
    if (!response.ok) {
      health.leaseHeld = false;
      log("lease_denied", { status: response.status });
      return null;
    }
    const body = (await response.json()) as { data?: { held?: boolean; leaseToken?: string | null } };
    const token = body.data?.held ? (body.data.leaseToken ?? null) : null;
    health.leaseHeld = token !== null;
    // Sunucuya ULAŞILDI: kirayı alamadıysak başka bir worker tutuyordur.
    if (token === null) health.lastErrorCode = "LEASE_NOT_HELD";
    return token;
  } catch {
    health.leaseHeld = false;
    // Sunucuya ULAŞILAMADI. Bu "yedek bekliyor" değildir; worker gerçekten
    // çalışmıyordur ve sağlık ucu bunu 503 olarak bildirmelidir.
    health.lastErrorCode = "APP_UNREACHABLE";
    log("lease_error", { code: "NETWORK" });
    return null;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  log("start", { workerId: config.workerId, intervalMs: config.intervalMs, version: WORKER_VERSION });

  const processStartedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      // "Süreç yaşıyor" YETMEZ: gözlem üretmeyen worker sağlıklı sayılmaz,
      // yoksa platform kurtarmayı hiç tetiklemez. Karar policy.ts'tedir.
      const healthy = healthyForPlatform(
        {
          status: health.status,
          lastErrorCode: health.lastErrorCode,
          lastSuccessAtMs: health.lastSuccessAt === null ? null : Date.parse(health.lastSuccessAt),
          startedAtMs: processStartedAt,
          intervalMs: config.intervalMs,
        },
        Date.now(),
      );
      response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...health, healthy }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(config.healthPort);

  let browser: Browser | null = null;
  let session: ScreenSession | null = null;
  let browserStartedAt = 0;
  let expectedSignature: string | null = null;
  let leaseToken: string | null = null;
  let attempt = 0;
  let stopping = false;
  let lastObservedAt: number | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    health.status = "stopped";
    log("shutdown", { signal });
    await session?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const restartBrowser = async (reason: string): Promise<void> => {
    // Sayaç yalnızca GERÇEK yeniden başlatmayı sayar. Kapatılacak bir tarayıcı
    // yoksa bu ilk açılıştır (veya zaten kapatılmıştır) ve sayılmaz; aksi hâlde
    // tek bir kurtarma yönetim ekranında iki restart gibi görünürdü.
    const hadBrowser = browser !== null || session !== null;
    if (hadBrowser) health.restartCount += 1;
    log(hadBrowser ? "browser_restart" : "browser_start", { reason, count: health.restartCount });
    await session?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    session = null;
    browser = null;
    // İmza yeniden öğrenilir; eski imzaya körü körüne güvenilmez.
    expectedSignature = null;
  };

  while (!stopping) {
    try {
      // Yeniden başlatma kararı tek yerde: services/sarraf-screen-worker/src/policy.ts
      const reason = restartReason(
        {
          browserCreated: browser !== null,
          browserConnected: browser?.isConnected() ?? false,
          sessionAlive: session?.alive ?? false,
          browserAgeMs: Date.now() - browserStartedAt,
          memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        },
        { browserMaxAgeMs: config.browserMaxAgeMs, memoryLimitMb: config.memoryLimitMb },
      );

      if (reason === "scheduled" || reason === "memory") {
        await restartBrowser(reason);
        continue;
      }

      if (reason !== null) {
        await restartBrowser(reason);
        browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
        health.browserVersion = browser.version();
        session = new ScreenSession(browser, config.targetUrl);
        await session.open();
        browserStartedAt = Date.now();
      }

      if (!leaseToken) {
        leaseToken = await acquireLease(config);
        if (!leaseToken) {
          // Yalnızca gerçekten "başka worker tutuyor" durumu degraded'dır;
          // uygulamaya ulaşılamıyorsa bu sağlıksızlıktır.
          health.status = health.lastErrorCode === "APP_UNREACHABLE" ? "unavailable" : "degraded";
          await sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
      }

      if (!session) {
        // Buraya normalde gelinmez: yeniden başlatma dalı oturumu kurar. Yine de
        // sessizce devam etmek yerine döngüyü baştan alırız.
        health.status = "unavailable";
        health.lastErrorCode = "SESSION_MISSING";
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }

      const observation = await session.observe(expectedSignature);
      if (expectedSignature === null && observation.ok) expectedSignature = observation.signature;

      if (!observation.ok) {
        health.status = observation.reason === "CAPTCHA" ? "blocked" : "unavailable";
        health.lastErrorCode = observation.reason ?? "UNKNOWN";
        health.captchaSeen = observation.captchaSeen;
        log("observation_blocked", { reason: observation.reason ?? "UNKNOWN" });
        // Fiyat GÖNDERİLMEZ. Sunucu tarafındaki bayatlık kuralı devreye girer.
        await sleep(config.intervalMs);
        continue;
      }

      const body = {
        workerId: config.workerId,
        workerVersion: WORKER_VERSION,
        browserVersion: health.browserVersion ?? "",
        mappingVersion: SARRAF_TV_SCREEN_MAPPING_VERSION,
        screenSignature: observation.signature,
        headers: observation.headers,
        observedAt: observation.observedAt,
        captchaSeen: false,
        restartCount: health.restartCount,
        observations: observation.quotes.map((quote) => ({
          canonicalProductId: quote.canonicalProductId,
          rawLabel: quote.rawProductName,
          mappingConfidence: quote.mappingConfidence,
          liquidationPrice: quote.liquidationPrice,
          replacementPrice: quote.replacementPrice,
          observedAt: observation.observedAt,
        })),
        unresolved: observation.unresolved,
      };

      const response = await post(config, "/api/internal/price-worker/sarraf-screen", body, leaseToken);
      if (response.status === 409) {
        // Kira devralınmış olabilir: yeniden alınır, bu tur atlanır.
        leaseToken = null;
        health.status = "degraded";
        health.lastErrorCode = "LEASE_STALE";
        log("lease_stale", {});
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        health.status = "degraded";
        health.lastErrorCode = `HTTP_${response.status}`;
        log("ingest_failed", { status: response.status });
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }

      const result = (await response.json()) as { data?: { accepted?: number; quarantined?: number } };
      const now = Date.now();
      health.status = "ok";
      health.lastSuccessAt = new Date(now).toISOString();
      health.lastErrorCode = null;
      health.resolvedCount = result.data?.accepted ?? 0;
      health.unresolvedCount = observation.unresolved.length;
      health.updateLagMs = lastObservedAt === null ? null : now - lastObservedAt;
      lastObservedAt = now;
      attempt = 0;
      log("observation_sent", {
        accepted: result.data?.accepted ?? 0,
        quarantined: result.data?.quarantined ?? 0,
        unresolved: observation.unresolved.length,
      });

      await sleep(config.intervalMs);
    } catch (error) {
      health.status = "degraded";
      health.lastErrorCode = error instanceof Error ? error.name : "UNKNOWN";
      log("loop_error", { code: health.lastErrorCode });
      await restartBrowser("error");
      await sleep(backoffMs(attempt));
      attempt += 1;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  // Yapılandırma hatasında eksik DEĞİŞKEN ADI yazılır (değeri değil); diğer
  // hatalarda yalnızca tür yazılır — mesajlar secret taşıyor olabilir.
  log("fatal", {
    code: error instanceof Error ? error.name : "UNKNOWN",
    variable: error instanceof ConfigError ? error.variable : null,
  });
  process.exit(1);
});
