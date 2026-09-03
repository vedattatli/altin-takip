import { chromium, type Browser } from "playwright-core";

import { SARRAF_TV_SCREEN_MAPPING_VERSION } from "../../../src/prices/providers/sarraf-tv-screen-mapping";
import { numberFromEnv, stringFromEnv } from "./policy";
import { ScreenSession } from "./screen-session";
import { signRequest } from "./signing";

/**
 * TEK SEFERLİK BULUT TOPLAYICI
 *
 *   npm run price:sarraf:collect-once
 *
 * Sürekli çalışan bir worker DEĞİLDİR. GitHub Actions'ta zamanlanmış her
 * çalıştırma bağımsızdır: tarayıcıyı açar, ekranı bir kez okur, imzalı gözlemi
 * gönderir ve kapanır. Kimsenin bilgisayarının açık olması gerekmez.
 *
 * Kurallar (sürekli worker ile aynı):
 *  - Supabase service_role BULUNMAZ; yalnız HMAC makine ucu bilinir.
 *  - CAPTCHA çözülmez; etkileşim istenirse fiyat ÜRETİLMEZ.
 *  - Ekran imzası beklenenden farklıysa fail closed.
 *  - Başarı yoksa eski fiyat yeni gözlem gibi GÖNDERİLMEZ.
 *  - Başka kaynağa veya test verisine düşülmez.
 *  - Secret log'a, çıktıya veya artefakta yazılmaz.
 */

const WORKER_VERSION = "collect-once-1.0.0";
const LEASE_PATH = "/api/internal/price-worker/lease";
const INGEST_PATH = "/api/internal/price-worker/sarraf-screen";
const PROVIDER_CODE = "sarraf-tv-kayseri-screen";

/** Zamanlanmış çalıştırma için kısa kira: sonraki koşumu kilitlemesin. */
const LEASE_TTL_SECONDS = 120;

interface Config {
  appUrl: string;
  secret: string;
  workerId: string;
  targetUrl: string;
  /** Sayfanın satırları doldurması için tanınan süre. */
  readBudgetMs: number;
}

class ConfigError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} tanımlı değil veya geçersiz.`);
    this.name = "ConfigError";
  }
}

function log(event: string, detail: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

function readConfig(): Config {
  const appUrl = stringFromEnv("APP_BASE_URL", "").replace(/\/$/u, "");
  const secret = stringFromEnv("PRICE_SCREEN_WORKER_SECRET", "");
  const targetUrl = stringFromEnv("SARRAF_SCREEN_URL", "");
  if (appUrl === "") throw new ConfigError("APP_BASE_URL");
  if (secret === "") throw new ConfigError("PRICE_SCREEN_WORKER_SECRET");
  if (targetUrl === "") throw new ConfigError("SARRAF_SCREEN_URL");
  return {
    appUrl,
    secret,
    workerId: stringFromEnv("PRICE_SCREEN_WORKER_ID", "github-actions"),
    targetUrl,
    readBudgetMs: numberFromEnv("COLLECT_READ_BUDGET_MS", 60_000, 1_000),
  };
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
    signal: AbortSignal.timeout(30_000),
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  log("collect_start", { workerId: config.workerId, version: WORKER_VERSION });

  let browser: Browser | null = null;
  let exitCode = 1;

  try {
    // 1. Kirayı al. Başka bir koşum yazıyorsa bu koşum SESSİZCE çekilir.
    const leaseResponse = await post(config, LEASE_PATH, { providerCode: PROVIDER_CODE, ttlSeconds: LEASE_TTL_SECONDS }, null);
    if (!leaseResponse.ok) {
      log("lease_denied", { status: leaseResponse.status });
      process.exit(75); // EX_TEMPFAIL: geçici, bir sonraki koşum dener.
    }
    const leaseBody = (await leaseResponse.json()) as { data?: { held?: boolean; leaseToken?: string | null } };
    const leaseToken = leaseBody.data?.held ? (leaseBody.data.leaseToken ?? null) : null;
    if (leaseToken === null) {
      log("lease_not_held");
      process.exit(75);
    }
    log("lease_acquired");

    // 2. Tarayıcıyı aç ve ekranı BİR KEZ oku.
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    log("browser_open", { version: browser.version() });

    const session = new ScreenSession(browser, config.targetUrl);
    await session.open();

    // Açılış ağ yanıtını BEKLE: yön kanıtı olmadan GREMSE değerlemeye giremez
    // ve koşum boşa gider. Gelmezse gözlem yine yapılır; yalnız çözülen ürün
    // sayısı düşer ve bu dürüstçe raporlanır.
    const networkReady = await session.waitForNetworkBootstrap(config.readBudgetMs);
    log("network_bootstrap", { ready: networkReady });

    const observation = await session.observe(null);
    if (!observation.ok) {
      // FAIL CLOSED: fiyat GÖNDERİLMEZ. Sunucudaki bayatlık kuralı devreye girer.
      log("observation_failed", { reason: observation.reason ?? "UNKNOWN", captcha: observation.captchaSeen });
      process.exit(observation.reason === "CAPTCHA" ? 76 : 75);
    }
    log("observation_ok", {
      products: observation.quotes.length,
      unresolved: observation.unresolved.length,
      headers: observation.headers.join("|"),
      signature: observation.signature,
    });
    // Güven dağılımı: kabul edilmeyen koşumun nedeni buradan okunur.
    // Ürün adı ve güven seviyesi hassas veri DEĞİLDİR; fiyat yazılmaz.
    for (const quote of observation.quotes) {
      log("observation_product", {
        product: quote.canonicalProductId,
        confidence: quote.mappingConfidence,
      });
    }

    // 3. İmzalı gönder.
    const body = {
      workerId: config.workerId,
      workerVersion: WORKER_VERSION,
      browserVersion: browser.version(),
      mappingVersion: SARRAF_TV_SCREEN_MAPPING_VERSION,
      screenSignature: observation.signature,
      headers: observation.headers,
      observedAt: observation.observedAt,
      captchaSeen: observation.captchaSeen,
      // Her gözlem KENDİ zaman damgasını taşımalıdır: sunucu bayatlığı gözlem
      // başına denetler ve alan eksikse GOZLEM_ZAMANI_GECERSIZ ile reddeder.
      observations: observation.quotes.map((quote) => ({
        canonicalProductId: quote.canonicalProductId,
        rawLabel: quote.rawProductName,
        mappingConfidence: quote.mappingConfidence,
        liquidationPrice: quote.liquidationPrice,
        replacementPrice: quote.replacementPrice,
        observedAt: observation.observedAt,
      })),
      unresolved: observation.unresolved,
      restartCount: 0,
    };

    const response = await post(config, INGEST_PATH, body, leaseToken);
    // COLLECT_DEBUG=true iken sunucunun cevabi olduğu gibi yazılır.
    // Yanıt secret İÇERMEZ; yalnız durum, sayılar ve çözülemeyen satırlar vardır.
    if (stringFromEnv("COLLECT_DEBUG", "") === "true") {
      const rawText = await response.clone().text().catch(() => "");
      log("ingest_raw", { body: rawText.slice(0, 2000) });
    }
    const result = (await response.json().catch(() => ({}))) as {
      data?: { accepted?: number; quarantined?: number; status?: string };
      code?: string;
    };

    if (!response.ok) {
      log("ingest_rejected", { status: response.status, code: result.code ?? "unknown" });
      process.exit(1);
    }

    log("ingest_accepted", {
      accepted: result.data?.accepted ?? 0,
      quarantined: result.data?.quarantined ?? 0,
      status: result.data?.status ?? "unknown",
    });
    exitCode = (result.data?.accepted ?? 0) > 0 ? 0 : 75;
  } catch (error) {
    log("collect_error", {
      code: error instanceof Error ? error.name : "UNKNOWN",
      variable: error instanceof ConfigError ? error.variable : null,
    });
    exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    log("collect_end", { exitCode });
  }

  process.exit(exitCode);
}

void main();
