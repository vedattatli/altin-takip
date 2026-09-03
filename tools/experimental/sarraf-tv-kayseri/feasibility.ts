/**
 * SARRAF TV KAYSERİ — TEKNİK FİZİBİLİTE ARACI (DENEYSEL, ÜRETİM DIŞI)
 *
 *   npm run price:sarraf-feasibility:headed
 *   npm run price:sarraf-feasibility:headless
 *   npm run price:sarraf-feasibility:strict
 *
 * AMAÇ: KAYSARDER fiyat sayfasından açılan Kayseri canlı fiyat ekranının NORMAL
 * bir tarayıcı oturumunda güvenilir biçimde okunup okunamayacağını kanıtlamak.
 * Bu araç üretim sağlayıcı mimarisinin PARÇASI DEĞİLDİR ve kullanıcı fiyatı
 * üretmez.
 *
 * SINIRLAR (ihlal edilmez):
 *  - CAPTCHA çözülmez, atlatılmaz; etkileşim istenirse sonuç BLOCKED'dır.
 *  - Bot koruması aşılmaz, sahte token/cookie üretilmez.
 *  - Tarayıcının doğal olarak yüklediği yanıtlar YALNIZCA gözlenir; hiçbir uç
 *    tarayıcı dışında bağımsız API gibi çağrılmaz veya tekrar oynatılmaz.
 *  - Artefaktlara cookie/authorization/token/parola/kişisel veri YAZILMAZ.
 *  - Veri alınamazsa başka kaynağa geçilmez, fiyat uydurulmaz.
 *
 * Sonuç dürüstçe raporlanır: FULL_OK | PARTIAL_OK | BLOCKED | UNAVAILABLE | NOT_RUN.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValuationReady } from "../../../src/prices/providers/sarraf-tv-screen-mapping";
import {
  compareSnapshots,
  extractQuotes,
  verifyAgainstScreenText,
  verifyNetworkAgainstScreen,
  type ExtractedQuote,
  type NetworkDomMismatch,
  type RawScreenRow,
} from "./extract";
import {
  extractNetworkPriceRows,
  isTwoSidedRow,
  schemaHasField,
  summarizeSchema,
  type ContractAnswers,
  type NetworkPriceRow,
  type SchemaSummary,
} from "./network-contract";
import { READ_SCREEN_SCRIPT } from "./reader";
import { findForbiddenTraces, mergeSummaries, summarizeRequest, type SafeRequestSummary } from "./sanitize";

const TARGET_URL = "https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri";
const DOC_PATH = join(process.cwd(), "docs", "SARRAF_TV_FEASIBILITY.md");

type Outcome = "FULL_OK" | "PARTIAL_OK" | "BLOCKED" | "UNAVAILABLE" | "NOT_RUN";
type BrowserMode = "headed" | "headless";

interface SnapshotRecord {
  at: string;
  domQuotes: ExtractedQuote[];
  networkQuotes: ExtractedQuote[];
  unresolved: { rawProductName: string; reason: string }[];
  numberFormat: string;
  screenMismatches: { productId: string; field: string; expected: string; screen: string }[];
  networkDomMismatches: NetworkDomMismatch[];
  signature: string;
}

interface RunReport {
  mode: BrowserMode;
  strict: boolean;
  outcome: Outcome;
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  browserVersion: string | null;
  launchOk: boolean;
  launchError: string | null;
  firstPriceMs: number | null;
  closeReason: string;
  /**
   * Koşum hatayla bittiyse hatanın ADI ve varsa kısa nedeni. Yalnızca hata
   * sınıfı ve Playwright'ın kendi mesajının ilk satırı yazılır; URL, çerez,
   * token veya sayfa içeriği YAZILMAZ.
   */
  closeError: string | null;
  captchaInteractionRequired: boolean;
  botProtectionScripts: string[];
  screen: {
    rowCount: number;
    resolvedCount: number;
    unresolvedCount: number;
    insideIframe: boolean;
    canvasOnly: boolean;
    hiddenMoneyCount: number;
    signature: string | null;
    autoUpdates: number;
  };
  timestamp: {
    /** Sağlayıcı fiyat zamanı KANITLANDI mı? (Genel saat regex'i kanıt sayılmaz.) */
    providerTimestampProven: boolean;
    providerTimestampSource: string | null;
    providerTimestampSample: string | null;
    observedAtKnown: boolean;
  };
  /** Açılışta ağ ↔ DOM yön doğrulamasının yapıldığı an. */
  bootstrapCheckedAt: string | null;
  bootstrapVerifiedLabels: string[];
  network: {
    contract: { path: string; schema: SchemaSummary }[];
    priceListPath: string | null;
    priceRowCount: number;
    answers: ContractAnswers;
    requests: SafeRequestSummary[];
  };
  snapshots: SnapshotRecord[];
  comparison: { pair: string; differences: number; detail: unknown }[];
  confidence: Record<string, number>;
  durabilityMinutes: number;
  notes: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function artifactDir(mode: BrowserMode): string {
  return join(process.cwd(), "artifacts", "sarraf-tv", mode);
}

/** Artefaktı yazmadan ÖNCE hassas iz taraması yapar. */
function writeSafe(path: string, content: string, notes: string[]): void {
  const traces = findForbiddenTraces(content);
  if (traces.length > 0) {
    notes.push(`ARTEFAKT YAZILMADI (${path}): hassas iz bulundu — ${traces.join(", ")}`);
    return;
  }
  writeFileSync(path, content, "utf8");
}

const CAPTCHA_INTERACTION_MARKERS = [
  "checking your browser",
  "are you a human",
  "robot değilim",
  "i'm not a robot",
  "doğrulamayı tamamlayın",
  "verify you are human",
];

const BOT_PROTECTION_HOSTS: readonly { host: string; label: string }[] = [
  { host: "google.com/recaptcha", label: "Google reCAPTCHA" },
  { host: "gstatic.com/recaptcha", label: "Google reCAPTCHA (kaynak)" },
  { host: "hcaptcha.com", label: "hCaptcha" },
  { host: "challenges.cloudflare.com", label: "Cloudflare Turnstile" },
  { host: "arkoselabs.com", label: "Arkose Labs" },
];

/**
 * Sayfa GERÇEKTEN etkileşim istiyor mu?
 *
 * Yalnızca "recaptcha script yüklendi" bunu göstermez: görünmez (skor tabanlı)
 * reCAPTCHA hiçbir etkileşim istemez. Bu yüzden BLOCKED kararı, kullanıcıdan
 * doğrulama isteyen METİN görüldüğünde verilir; script varlığı ayrıca raporlanır.
 */
export function interactionRequired(text: string): boolean {
  const value = text.toLocaleLowerCase("tr-TR");
  return CAPTCHA_INTERACTION_MARKERS.some((marker) => value.includes(marker));
}

interface ReaderResult {
  rows: RawScreenRow[];
  headers: string[];
  headerTop: number | null;
  signature: string;
  canvasCount: number;
  bodyText: string;
  hiddenMoneyCount: number;
}

/** Ağ satırlarını, ekran çıkarıcısıyla aynı biçime çevirir. */
function networkRowsToScreenRows(rows: readonly NetworkPriceRow[]): RawScreenRow[] {
  return rows
    .map((row) => ({
      label: row.title,
      // Yön ALAN ADLARINDAN bilinir; sütun konumuna bakılmaz.
      cells: { ALIŞ: String(row.buying), SATIŞ: String(row.sales) },
      directionResolved: true,
    }));
}

/** CLI argümanı okur (Windows'ta `VAR=x komut` çalışmadığı için env yerine argüman). */
function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const modeArg = argValue("mode") ?? process.env.SARRAF_FEASIBILITY_MODE ?? "headed";
  const mode: BrowserMode = modeArg === "headless" ? "headless" : "headed";
  const strict = process.argv.includes("--strict") || process.env.SARRAF_FEASIBILITY_STRICT === "1";
  const durabilityMinutes = Number(argValue("minutes") ?? process.env.SARRAF_FEASIBILITY_MINUTES ?? "10");
  const dir = artifactDir(mode);
  mkdirSync(dir, { recursive: true });

  const notes: string[] = [];
  const startedAtMs = Date.now();
  const report: RunReport = {
    mode,
    strict,
    outcome: "NOT_RUN",
    reason: "",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationSeconds: 0,
    browserVersion: null,
    launchOk: false,
    launchError: null,
    firstPriceMs: null,
    closeReason: "normal",
    closeError: null,
    captchaInteractionRequired: false,
    botProtectionScripts: [],
    screen: {
      rowCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      insideIframe: false,
      canvasOnly: false,
      hiddenMoneyCount: 0,
      signature: null,
      autoUpdates: 0,
    },
    timestamp: {
      providerTimestampProven: false,
      providerTimestampSource: null,
      providerTimestampSample: null,
      observedAtKnown: true,
    },
    bootstrapCheckedAt: null,
    bootstrapVerifiedLabels: [],
    network: {
      contract: [],
      priceListPath: null,
      priceRowCount: 0,
      answers: {
        feedsPriceTable: null,
        hasProductTitle: false,
        hasSeparateBuySell: false,
        hasNewOldDistinction: false,
        ataResatSeparated: false,
        singlePriceDirectionKnown: false,
        hasUpstreamTimestamp: false,
        currencyExplicit: false,
      },
      requests: [],
    },
    snapshots: [],
    comparison: [],
    confidence: {},
    durabilityMinutes,
    notes,
  };

  let chromium: typeof import("playwright-core").chromium | null = null;
  try {
    ({ chromium } = (await import("@playwright/test")) as unknown as {
      chromium: typeof import("playwright-core").chromium;
    });
  } catch {
    report.reason = "Playwright bulunamadı; tarayıcı oturumu açılamadı.";
    finish(report, dir, strict);
    return;
  }

  const requests: SafeRequestSummary[] = [];
  const botProtection: string[] = [];
  const schemas = new Map<string, SchemaSummary>();
  let latestNetworkRows: NetworkPriceRow[] = [];
  let latestNetworkAt: string | null = null;
  // Ağ yanıtı her geldiğinde artar. DOM okumasının AYNI turu yansıttığını
  // doğrulamak için kullanılır: fiyat volatil olduğundan farklı anlarda alınan
  // iki gözlemi karşılaştırmak sahte uyuşmazlık üretir.
  let networkVersion = 0;
  let browser: import("playwright-core").Browser | null = null;

  try {
    try {
      // Worker ile AYNI argümanlar. Aksi hâlde araç, pilotun gerçekte
      // çalıştırdığı yapılandırmayı değil başka bir yapılandırmayı ölçer;
      // `--disable-dev-shm-usage` olmadan uzun koşumlarda sayfa çöküyordu.
      browser = await chromium.launch({
        headless: mode === "headless",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      report.launchOk = true;
      report.browserVersion = browser.version();
    } catch (error) {
      report.launchOk = false;
      report.launchError = error instanceof Error ? error.name : "bilinmeyen hata";
      report.outcome = "NOT_RUN";
      report.reason = `Chromium ${mode} modda açılamadı.`;
      finish(report, dir, strict);
      return;
    }

    const context = await browser.newContext({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    page.on("response", (response) => {
      const rawUrl = response.url();
      for (const marker of BOT_PROTECTION_HOSTS) {
        if (rawUrl.includes(marker.host) && !botProtection.includes(marker.label)) {
          botProtection.push(marker.label);
        }
      }
      const contentType = response.headers()["content-type"] ?? null;
      const summary = summarizeRequest(
        rawUrl,
        response.request().method(),
        response.request().resourceType(),
        response.status(),
        contentType,
      );
      if (summary) requests.push(summary);
      if (!contentType || !contentType.includes("json")) return;

      // Yalnızca GÖZLEM: yanıt tarayıcı tarafından zaten yüklendi. Uç bağımsız
      // olarak çağrılmaz; gövde saklanmaz, yalnızca güvenli şema özeti çıkarılır.
      void response
        .json()
        .then((body: unknown) => {
          let url: URL;
          try {
            url = new URL(rawUrl);
          } catch {
            return;
          }
          const path = `${url.host}${url.pathname}`;
          if (!schemas.has(path)) schemas.set(path, summarizeSchema(body));
          const rows = extractNetworkPriceRows(body);
          if (rows.length > 0) {
            latestNetworkRows = rows;
            latestNetworkAt = nowIso();
            networkVersion += 1;
            report.network.priceListPath = path;
            if (report.firstPriceMs === null) report.firstPriceMs = Date.now() - startedAtMs;
          }
        })
        .catch(() => undefined);
    });

    let loaded = false;
    try {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      loaded = true;
    } catch (error) {
      report.outcome = "UNAVAILABLE";
      report.reason = `Sayfa yüklenemedi: ${error instanceof Error ? error.name : "bilinmeyen hata"}.`;
      report.closeReason = "load-failed";
    }

    if (loaded) {
      await page.waitForTimeout(8_000);

      const readAllFrames = async (): Promise<{ result: ReaderResult | null; fromMainFrame: boolean }> => {
        let best: ReaderResult | null = null;
        let fromMainFrame = false;
        for (const frame of page.frames()) {
          const result = (await frame.evaluate(READ_SCREEN_SCRIPT).catch(() => null)) as ReaderResult | null;
          if (!result) continue;
          if (best === null || result.rows.length > best.rows.length) {
            best = result;
            fromMainFrame = frame === page.mainFrame();
          }
        }
        return { result: best, fromMainFrame };
      };

      /**
       * Ağ turu ile DOM okumasını hizalar.
       *
       * Sayfa, DOM'u aldığı ağ yanıtından günceller. Yanıt ile okuma arasında
       * yeni bir tur gelirse iki gözlem farklı anlara ait olur ve karşılaştırma
       * sahte uyuşmazlık üretir. Bu yüzden: yanıt gelir → kısa bir yerleşme
       * süresi beklenir → DOM okunur → bu sırada yeni tur geldiyse tekrarlanır.
       */
      const readAligned = async (): Promise<{ result: ReaderResult | null; fromMainFrame: boolean; aligned: boolean }> => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const versionBefore = networkVersion;
          await page.waitForTimeout(1_500);
          const read = await readAllFrames();
          if (networkVersion === versionBefore) {
            return { ...read, aligned: true };
          }
        }
        const fallback = await readAllFrames();
        return { ...fallback, aligned: false };
      };

      // Açılışta yönü doğrulanan başlıklar; sonraki gözlemlerde yeniden hesaplanmaz.
      let bootstrapVerifiedLabels = new Set<string>();
      let bootstrapCheckedAt: string | null = null;

      const takeSnapshot = async (index: number): Promise<void> => {
        const { result, fromMainFrame, aligned } = await readAligned();
        if (!aligned) notes.push(`Gözlem ${index}: ağ turu ile DOM okuması hizalanamadı (fiyat çok sık güncelleniyor).`);
        if (!result) {
          notes.push(`Gözlem ${index}: ekran okunamadı.`);
          return;
        }
        if (interactionRequired(result.bodyText)) report.captchaInteractionRequired = true;
        if (result.rows.length > 0) report.screen.insideIframe = !fromMainFrame;
        report.screen.canvasOnly = result.rows.length === 0 && result.canvasCount > 0;
        report.screen.rowCount = Math.max(report.screen.rowCount, result.rows.length);
        report.screen.hiddenMoneyCount = result.hiddenMoneyCount;
        report.screen.signature = result.signature;

        // KANAL ROLLERİ
        //
        // Ölçüldü: bayi fiyatları tarayıcıda HESAPLANIYOR. `price/list` yalnızca
        // açılışta bir kez gelir (parametreler + başlangıç fiyatı); canlı akış
        // WebSocket üzerinden yalnızca GENEL PİYASA kurunu taşır (XAUUSD vb.).
        // Nihai bayi fiyatı sadece DOM'da bulunur.
        //
        // Bu yüzden:
        //   - DOM = canlı DEĞER kanalı (birincil).
        //   - Ağ yanıtı = SÖZLEŞME kanıtı (yön, alan adları, kaynak zamanı) ve
        //     yalnızca AÇILIŞ anında değer karşılaştırması için kullanılır.
        // Sonraki gözlemlerde REST yükü bayatladığı için değer karşılaştırması
        // yapılmaz; yapılsaydı fiyat her tikte "uyuşmazlık" üretirdi.
        const visibleNetworkRows = latestNetworkRows.filter((row) => !row.isFooter);
        const twoSidedRows = visibleNetworkRows.filter((row) => isTwoSidedRow(row));
        const oneSidedRows = visibleNetworkRows.filter((row) => !isTwoSidedRow(row));
        const twoSidedLabels = new Set(twoSidedRows.map((row) => row.title));
        const networkExtraction = extractQuotes(networkRowsToScreenRows(twoSidedRows), "network", {
          networkVerifiedLabels: twoSidedLabels,
        });

        let networkDomMismatches: NetworkDomMismatch[] = [];
        if (index === 1) {
          // AÇILIŞ DOĞRULAMASI: ekranın ALIŞ sütunu gerçekten `buying` mi?
          networkDomMismatches = verifyNetworkAgainstScreen(networkExtraction.quotes, result.rows);
          bootstrapVerifiedLabels = new Set(
            networkExtraction.quotes
              .filter((quote) => !networkDomMismatches.some((m) => m.label === quote.rawProductName))
              .map((quote) => quote.rawProductName),
          );
          bootstrapCheckedAt = nowIso();
          report.bootstrapCheckedAt = bootstrapCheckedAt;
          report.bootstrapVerifiedLabels = [...bootstrapVerifiedLabels];
        }

        const domExtraction = extractQuotes(result.rows, fromMainFrame ? "dom" : "iframe-dom", {
          networkVerifiedLabels: bootstrapVerifiedLabels,
        });
        const screenMismatches = verifyAgainstScreenText(domExtraction.quotes, result.rows);

        const at = nowIso();
        // Tek yönlü referans fiyatlar (ekranda tek sayı) değerlemeye giremez.
        const unresolvedRows = [
          ...domExtraction.unresolved.filter((row) => !oneSidedRows.some((n) => n.title === row.rawProductName)),
          ...oneSidedRows.map((row) => ({
            rawProductName: row.title,
            reason: "TEK_YÖNLÜ_REFERANS_FİYAT",
          })),
        ];
        report.snapshots.push({
          at,
          domQuotes: domExtraction.quotes,
          networkQuotes: networkExtraction.quotes,
          unresolved: unresolvedRows,
          numberFormat: domExtraction.numberFormat,
          screenMismatches,
          networkDomMismatches,
          signature: result.signature,
        });

        writeSafe(
          join(dir, `snapshot-0${index}.json`),
          JSON.stringify(
            {
              observedAt: at,
              mode,
              sourceUrl: TARGET_URL,
              signature: result.signature,
              numberFormat: domExtraction.numberFormat,
              domRowCount: result.rows.length,
              headers: result.headers,
              screenRows: result.rows,
              domQuotes: domExtraction.quotes,
              networkQuotes: networkExtraction.quotes,
              networkObservedAt: latestNetworkAt,
              unresolved: unresolvedRows,
              domUnresolved: domExtraction.unresolved,
              screenMismatches,
              networkDomMismatches,
            },
            null,
            2,
          ),
          notes,
        );
        await page
          .screenshot({ path: join(dir, `screenshot-0${index}.png`), fullPage: true })
          .catch(() => notes.push(`Ekran görüntüsü alınamadı (#${index}).`));
      };

      await takeSnapshot(1);

      if (report.captchaInteractionRequired) {
        report.outcome = "BLOCKED";
        report.reason = "Sayfa kullanıcı doğrulaması istedi. Aşma girişiminde BULUNULMADI.";
        report.closeReason = "captcha";
      } else {
        // Dayanıklılık: aynı oturum açık kalır, sayfa yenilenmez.
        const totalMs = Math.max(1, durabilityMinutes) * 60_000;
        const started = Date.now();
        let previous = JSON.stringify(report.snapshots[0]?.domQuotes ?? []);
        let midTaken = false;
        while (Date.now() - started < totalMs) {
          await page.waitForTimeout(20_000);
          const { result } = await readAllFrames();
          if (!result) continue;
          const networkLabels = new Set(latestNetworkRows.map((row) => row.title));
          const current = JSON.stringify(
            extractQuotes(result.rows, "dom", { networkVerifiedLabels: networkLabels }).quotes,
          );
          if (current !== previous) {
            report.screen.autoUpdates += 1;
            previous = current;
          }
          if (!midTaken && Date.now() - started >= totalMs / 2) {
            await takeSnapshot(2);
            midTaken = true;
          }
        }
        if (!midTaken) await takeSnapshot(2);
        await takeSnapshot(3);
      }
    }

    // --- Zaman damgası kanıtı ---
    // Genel bir saat regex'i KANIT SAYILMAZ. Yalnızca ağ sözleşmesindeki
    // `updatedAt` alanı ya da açıkça etiketlenmiş bir DOM alanı kanıt olur.
    const priceSchema = report.network.priceListPath ? schemas.get(report.network.priceListPath) : undefined;
    const upstreamSample = latestNetworkRows.find((row) => row.updatedAt !== null)?.updatedAt ?? null;
    if (priceSchema && schemaHasField(priceSchema, "updatedAt") && upstreamSample) {
      report.timestamp.providerTimestampProven = true;
      report.timestamp.providerTimestampSource = `${report.network.priceListPath} → updatedAt`;
      report.timestamp.providerTimestampSample = upstreamSample;
    }

    report.network.contract = [...schemas.entries()]
      .filter(([path]) => !path.includes("recaptcha") && !path.includes("gstatic"))
      .map(([path, schema]) => ({ path, schema }));
    report.network.priceRowCount = latestNetworkRows.length;
    report.network.answers = {
      feedsPriceTable: report.network.priceListPath,
      hasProductTitle: priceSchema ? schemaHasField(priceSchema, "title") : false,
      hasSeparateBuySell: priceSchema
        ? schemaHasField(priceSchema, "buying") && schemaHasField(priceSchema, "sales")
        : false,
      // Yeni/eski ayrımı yalnızca başlıklarda "YENİ"/"ESKİ" geçiyorsa vardır.
      hasNewOldDistinction: latestNetworkRows.some((row) => /yeni|eski/iu.test(row.title)),
      ataResatSeparated: !latestNetworkRows.some((row) => /ata\s*-\s*reşat/iu.test(row.title)),
      // Tek fiyatlı satırlarda `buying` ve `sales` EŞİT geliyor ve kaynak onları
      // tek yönlü işaretliyor: bu bir yön kanıtı DEĞİLDİR.
      singlePriceDirectionKnown: false,
      hasUpstreamTimestamp: report.timestamp.providerTimestampProven,
      currencyExplicit: priceSchema ? schemaHasField(priceSchema, "currency") : false,
    };
  } catch (error) {
    if (report.outcome === "NOT_RUN") report.outcome = "UNAVAILABLE";
    report.reason = report.reason || `Beklenmeyen hata: ${error instanceof Error ? error.name : "bilinmiyor"}.`;
    report.closeReason = "error";
    // Hata SINIFI ve mesajın ilk satırı kaydedilir; teşhis edilemeyen bir
    // "error" kapanışı sessiz bir arıza demektir.
    report.closeError =
      error instanceof Error
        ? `${error.name}: ${(error.message ?? "").split(/\r?\n/u)[0].slice(0, 200)}`
        : "bilinmiyor";
  } finally {
    await browser?.close().catch(() => undefined);
  }

  report.botProtectionScripts = botProtection;
  report.network.requests = mergeSummaries(requests);

  // --- Sonuç sınıflandırması ---
  if (report.outcome !== "BLOCKED" && report.snapshots.length > 0) {
    const lastSnapshot = report.snapshots[report.snapshots.length - 1];
    // Birincil kanal DOM'dur (canlı değer); ağ yanıtı yönü açılışta doğrular.
    const primary = lastSnapshot?.domQuotes ?? [];
    const resolved = primary.length;
    const unresolved = lastSnapshot?.unresolved.length ?? 0;
    const screenMismatches = report.snapshots.reduce((sum, s) => sum + s.screenMismatches.length, 0);
    const networkMismatches = report.snapshots.reduce((sum, s) => sum + s.networkDomMismatches.length, 0);
    report.screen.resolvedCount = resolved;
    report.screen.unresolvedCount = unresolved;

    for (const quote of primary) {
      report.confidence[quote.mappingConfidence] = (report.confidence[quote.mappingConfidence] ?? 0) + 1;
    }

    if (resolved === 0) {
      report.outcome = "UNAVAILABLE";
      report.reason = "Ekrandan hiçbir ürün güvenilir biçimde okunamadı.";
    } else if (screenMismatches > 0 || networkMismatches > 0) {
      report.outcome = "UNAVAILABLE";
      report.reason = `Doğrulama başarısız: ekran ↔ JSON ${screenMismatches}, açılışta ağ ↔ DOM ${networkMismatches} uyuşmazlık. Kısmi başarı tam başarı sayılmaz.`;
    } else if (unresolved > 0) {
      report.outcome = "PARTIAL_OK";
      report.reason = `${resolved} ürün okundu ve doğrulandı; ${unresolved} satır bilerek çözülmedi.`;
    } else {
      report.outcome = "FULL_OK";
      report.reason = "Ekrandaki bütün satırlar çözüldü ve değerler birebir doğrulandı.";
    }
  }

  for (let index = 1; index < report.snapshots.length; index += 1) {
    const previous = report.snapshots[index - 1]!;
    const current = report.snapshots[index]!;
    const differences = compareSnapshots(previous.domQuotes, current.domQuotes);
    report.comparison.push({
      pair: `${index}-${index + 1}`,
      differences: differences.length,
      detail: differences.slice(0, 20),
    });
  }

  report.finishedAt = nowIso();
  report.durationSeconds = Math.round((Date.now() - startedAtMs) / 1000);
  finish(report, dir, strict);
}

/**
 * PİLOT KABUL KRİTERİ (strict komut bunu uygular)
 *
 * Kısmi okuma kabul edilebilir; ama okunan her fiyatın yönü kanıtlanmış,
 * ekranla ve ağ yanıtıyla birebir uyuşmuş olmalıdır.
 */
export function meetsPilotCriteria(report: RunReport): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (report.outcome !== "FULL_OK" && report.outcome !== "PARTIAL_OK") {
    failures.push(`sonuç ${report.outcome}`);
  }
  const valuationReady = Object.entries(report.confidence)
    .filter(([confidence]) => isValuationReady(confidence as never))
    .reduce((sum, [, count]) => sum + count, 0);
  if (valuationReady === 0) failures.push("değerlemeye hazır (NETWORK_VERIFIED) ürün yok");
  const screenMismatches = report.snapshots.reduce((sum, s) => sum + s.screenMismatches.length, 0);
  if (screenMismatches > 0) failures.push(`ekran ↔ JSON uyuşmazlığı: ${screenMismatches}`);
  const networkMismatches = report.snapshots.reduce((sum, s) => sum + s.networkDomMismatches.length, 0);
  if (networkMismatches > 0) failures.push(`ağ ↔ DOM uyuşmazlığı: ${networkMismatches}`);
  if (!report.timestamp.providerTimestampProven) failures.push("kaynak zaman damgası kanıtlanmadı");
  if (report.captchaInteractionRequired) failures.push("CAPTCHA etkileşimi istendi");
  if (report.snapshots.length < 3) failures.push("üç gözlem tamamlanmadı");
  return { ok: failures.length === 0, failures };
}

function finish(report: RunReport, dir: string, strict: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeSafe(
    join(dir, "sanitized-network-summary.json"),
    JSON.stringify({ generatedAt: nowIso(), mode: report.mode, target: TARGET_URL, requests: report.network.requests }, null, 2),
    report.notes,
  );
  writeSafe(
    join(dir, "run-report.json"),
    JSON.stringify(
      {
        mode: report.mode,
        outcome: report.outcome,
        reason: report.reason,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        durationSeconds: report.durationSeconds,
        browserVersion: report.browserVersion,
        launchOk: report.launchOk,
        launchError: report.launchError,
        firstPriceMs: report.firstPriceMs,
        closeReason: report.closeReason,
        closeError: report.closeError,
        captchaInteractionRequired: report.captchaInteractionRequired,
        botProtectionScripts: report.botProtectionScripts,
        screen: report.screen,
        timestamp: report.timestamp,
        bootstrapCheckedAt: report.bootstrapCheckedAt,
        bootstrapVerifiedLabels: report.bootstrapVerifiedLabels,
        confidence: report.confidence,
        comparison: report.comparison,
        snapshots: report.snapshots.map((snapshot) => ({
          at: snapshot.at,
          signature: snapshot.signature,
          domQuoteCount: snapshot.domQuotes.length,
          networkQuoteCount: snapshot.networkQuotes.length,
          unresolved: snapshot.unresolved,
          screenMismatches: snapshot.screenMismatches,
          networkDomMismatches: snapshot.networkDomMismatches,
        })),
      },
      null,
      2,
    ),
    report.notes,
  );

  // Ağ sözleşmesi özeti ve ağ↔DOM karşılaştırması ortak dizine yazılır.
  const sharedDir = join(process.cwd(), "artifacts", "sarraf-tv");
  mkdirSync(sharedDir, { recursive: true });
  writeSafe(
    join(sharedDir, "network-contract-summary.json"),
    JSON.stringify(
      {
        generatedAt: nowIso(),
        mode: report.mode,
        note:
          "Yalnızca GÖZLEM. Bu uçlar tarayıcı dışında çağrılmadı, tekrar oynatılmadı. " +
          "Değerler varsayılan olarak yazılmaz; hassas alanlar REDACTED işaretlidir.",
        priceListPath: report.network.priceListPath,
        priceRowCount: report.network.priceRowCount,
        answers: report.network.answers,
        contract: report.network.contract,
      },
      null,
      2,
    ),
    report.notes,
  );
  writeSafe(
    join(sharedDir, "network-dom-comparison.json"),
    JSON.stringify(
      {
        generatedAt: nowIso(),
        mode: report.mode,
        snapshots: report.snapshots.map((snapshot) => ({
          at: snapshot.at,
          networkQuoteCount: snapshot.networkQuotes.length,
          domQuoteCount: snapshot.domQuotes.length,
          mismatches: snapshot.networkDomMismatches,
        })),
      },
      null,
      2,
    ),
    report.notes,
  );
  writeSafe(DOC_PATH, renderDoc(report), report.notes);

  const criteria = meetsPilotCriteria(report);

  console.log("");
  console.log(`== Sarraf TV Kayseri fizibilitesi (${report.mode}) ==`);
  console.log(`Sonuç        : ${report.outcome}`);
  console.log(`Açıklama     : ${report.reason}`);
  console.log(`Süre         : ${report.durationSeconds} sn`);
  console.log(`Chromium     : ${report.browserVersion ?? "açılamadı"}`);
  console.log(`İlk fiyat    : ${report.firstPriceMs === null ? "gelmedi" : `${report.firstPriceMs} ms`}`);
  console.log(`Ekran satırı : ${report.screen.rowCount} (çözülen ${report.screen.resolvedCount}, çözülemeyen ${report.screen.unresolvedCount})`);
  console.log(`Ağ satırı    : ${report.network.priceRowCount}`);
  console.log(`Kaynak zamanı: ${report.timestamp.providerTimestampProven ? `KANITLANDI (${report.timestamp.providerTimestampSource})` : "kanıtlanmadı"}`);
  console.log(`CAPTCHA      : ${report.captchaInteractionRequired ? "ETKİLEŞİM İSTENDİ (aşılmadı)" : "etkileşim istenmedi"}`);
  console.log(`Bot koruma   : ${report.botProtectionScripts.length > 0 ? report.botProtectionScripts.join(", ") : "tespit edilmedi"}`);
  console.log(`Güncelleme   : ${report.screen.autoUpdates}`);
  console.log(`Eşleme       : ${Object.entries(report.confidence).map(([k, v]) => `${k}=${v}`).join(", ") || "yok"}`);
  console.log(`Kapanış      : ${report.closeReason}`);
  if (report.closeError !== null) console.log(`Kapanış hatası: ${report.closeError}`);
  for (const note of report.notes) console.log(`Not          : ${note}`);

  if (strict) {
    console.log("");
    if (criteria.ok) {
      console.log("STRICT: pilot kabul kriterleri karşılandı.");
      process.exit(0);
    }
    console.log(`STRICT BAŞARISIZ: ${criteria.failures.join("; ")}`);
    process.exit(1);
  }

  if (report.outcome !== "FULL_OK" && report.outcome !== "PARTIAL_OK") {
    console.log("");
    console.log("Bu bir başarısızlık DEĞİL, dürüst bir sonuçtur: gerçek fiyat okunamadı.");
    console.log("Başka kaynağa geçilmedi ve fiyat uydurulmadı.");
  }
  process.exit(0);
}

function renderDoc(report: RunReport): string {
  const lines: string[] = [];
  lines.push("# Sarraf TV Kayseri — Teknik Fizibilite Raporu");
  lines.push("");
  lines.push("> Bu rapor otomatik üretilir. Araç deneyseldir, üretim sağlayıcı mimarisinin");
  lines.push("> parçası DEĞİLDİR ve kullanıcıya fiyat üretmez. CAPTCHA aşılmaz, bot koruması");
  lines.push("> delinmez, hiçbir uç tarayıcı dışında çağrılmaz.");
  lines.push("");
  lines.push(`- **Tarayıcı modu:** \`${report.mode}\``);
  lines.push(`- **Başlangıç:** ${report.startedAt}`);
  lines.push(`- **Bitiş:** ${report.finishedAt} (${report.durationSeconds} sn)`);
  lines.push(`- **Chromium:** ${report.browserVersion ?? "açılamadı"}`);
  lines.push(`- **Hedef:** \`${TARGET_URL}\``);
  lines.push(`- **Sonuç:** \`${report.outcome}\``);
  lines.push(`- **Açıklama:** ${report.reason}`);
  lines.push("");
  lines.push("> Bu dosya SON çalıştırmanın modunu yansıtır. Her iki mod için ayrı ham");
  lines.push("> artefaktlar `artifacts/sarraf-tv/headed/` ve `artifacts/sarraf-tv/headless/`");
  lines.push("> altındadır; oradaki `run-report.json` dosyaları modu ayrı ayrı kanıtlar.");
  lines.push("");
  lines.push("## Koşum bilgileri");
  lines.push("");
  lines.push("| Alan | Değer |");
  lines.push("| --- | --- |");
  lines.push(`| Chromium açıldı mı? | ${report.launchOk ? "Evet" : `Hayır (${report.launchError ?? "-"})`} |`);
  lines.push(`| İlk fiyatın gelme süresi | ${report.firstPriceMs === null ? "gelmedi" : `${report.firstPriceMs} ms`} |`);
  lines.push(`| Ekran satırı | ${report.screen.rowCount} |`);
  lines.push(`| Çözülen satır | ${report.screen.resolvedCount} |`);
  lines.push(`| Çözülemeyen satır | ${report.screen.unresolvedCount} |`);
  lines.push(`| Gizli/ölçülemeyen fiyat düğümü | ${report.screen.hiddenMoneyCount} |`);
  lines.push(`| Ekran imzası | \`${report.screen.signature ?? "-"}\` |`);
  lines.push(`| CAPTCHA script'i yüklendi mi? | ${report.botProtectionScripts.length > 0 ? report.botProtectionScripts.join(", ") : "hayır"} |`);
  lines.push(`| Gerçek kullanıcı etkileşimi gerekti mi? | ${report.captchaInteractionRequired ? "EVET (aşılmadı)" : "hayır"} |`);
  lines.push(`| Kapanma nedeni | ${report.closeReason} |`);
  if (report.closeError !== null) lines.push(`| Kapanma hatası | \`${report.closeError}\` |`);
  lines.push(`| Otomatik güncelleme (gözlem süresince) | ${report.screen.autoUpdates} |`);
  lines.push("");
  lines.push("## Zaman damgası");
  lines.push("");
  lines.push("Genel bir saat kalıbı (`12:30`) kaynak zamanı KANITI SAYILMAZ; sayfada saat");
  lines.push("gösteren herhangi bir metin bu kalıba uyabilir.");
  lines.push("");
  lines.push("| Soru | Yanıt |");
  lines.push("| --- | --- |");
  lines.push(`| Sağlayıcının fiyat zamanı kanıtlandı mı? | ${report.timestamp.providerTimestampProven ? "Evet" : "Hayır"} |`);
  lines.push(`| Kanıt kaynağı | ${report.timestamp.providerTimestampSource ?? "-"} |`);
  lines.push(`| Örnek | ${report.timestamp.providerTimestampSample ?? "-"} |`);
  lines.push(`| Bizim gözlem zamanımız biliniyor mu? | ${report.timestamp.observedAtKnown ? "Evet" : "Hayır"} |`);
  lines.push(`| Açılışta yön doğrulaması | ${report.bootstrapCheckedAt ?? "yapılmadı"} |`);
  lines.push(`| Yönü doğrulanan başlıklar | ${report.bootstrapVerifiedLabels.join(", ") || "yok"} |`);
  lines.push("");
  lines.push("## Doğal tarayıcı oturumundaki fiyat sözleşmesi");
  lines.push("");
  lines.push("| Soru | Yanıt |");
  lines.push("| --- | --- |");
  lines.push(`| Fiyat tablosunu besleyen yanıt | ${report.network.answers.feedsPriceTable ?? "bulunamadı"} |`);
  lines.push(`| Ürün başlığı var mı? | ${report.network.answers.hasProductTitle ? "Evet (`title`)" : "Hayır"} |`);
  lines.push(`| Alış ve satış ayrı alanlarda mı? | ${report.network.answers.hasSeparateBuySell ? "Evet (`buying` / `sales`)" : "Hayır"} |`);
  lines.push(`| Yeni/eski ayrımı var mı? | ${report.network.answers.hasNewOldDistinction ? "Evet" : "Hayır"} |`);
  lines.push(`| ATA ve Reşat ayrı mı? | ${report.network.answers.ataResatSeparated ? "Evet" : "Hayır (tek satırda birleşik)"} |`);
  lines.push(`| Tek fiyatlı satırın yönü belli mi? | ${report.network.answers.singlePriceDirectionKnown ? "Evet (alan adlarından)" : "Hayır"} |`);
  lines.push(`| Kaynak fiyat zamanı var mı? | ${report.network.answers.hasUpstreamTimestamp ? "Evet" : "Hayır"} |`);
  lines.push(`| Para birimi açıkça belirtiliyor mu? | ${report.network.answers.currencyExplicit ? "Evet" : "Hayır"} |`);
  lines.push(`| Ağdan okunan satır | ${report.network.priceRowCount} |`);
  lines.push("");
  const totalNetworkDom = report.snapshots.reduce((sum, s) => sum + s.networkDomMismatches.length, 0);
  lines.push(`**Ağ ↔ DOM uyuşmazlığı:** ${totalNetworkDom}`);
  lines.push("");
  lines.push("## Eşleme güveni");
  lines.push("");
  if (Object.keys(report.confidence).length === 0) {
    lines.push("Çözülen ürün yok.");
  } else {
    lines.push("| Güven | Ürün sayısı | Değerlemeye girer mi? |");
    lines.push("| --- | --- | --- |");
    for (const [confidence, count] of Object.entries(report.confidence)) {
      lines.push(`| ${confidence} | ${count} | ${isValuationReady(confidence as never) ? "Evet" : "Hayır (onay gerekir)"} |`);
    }
  }
  lines.push("");
  lines.push("## Okunan ürünler");
  lines.push("");
  if (report.snapshots.length === 0) {
    lines.push("Hiç gözlem alınamadı.");
  } else {
    for (const [index, snapshot] of report.snapshots.entries()) {
      lines.push(`### Gözlem ${index + 1} — ${snapshot.at}`);
      lines.push("");
      if (snapshot.domQuotes.length === 0) {
        lines.push("Okunabilen ürün yok.");
      } else {
        lines.push("| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |");
        lines.push("| --- | --- | --- | --- | --- | --- | --- |");
        for (const quote of snapshot.domQuotes) {
          lines.push(
            `| ${quote.rawProductName} | ${quote.canonicalProductId} | ${quote.mappingConfidence} | ${quote.rawBuyLabel} | ${quote.rawSellLabel} | ${quote.liquidationPrice} | ${quote.replacementPrice} |`,
          );
        }
      }
      if (snapshot.unresolved.length > 0) {
        lines.push("");
        lines.push("Çözülemeyen satırlar (tahmin YAPILMADI):");
        for (const row of snapshot.unresolved) lines.push(`- ${row.rawProductName} — ${row.reason}`);
      }
      lines.push("");
    }
  }
  lines.push("## Gözlem karşılaştırması");
  lines.push("");
  if (report.comparison.length === 0) {
    lines.push("Karşılaştırılacak ikinci gözlem yok.");
  } else {
    for (const item of report.comparison) lines.push(`- Gözlem ${item.pair}: ${item.differences} fark`);
  }
  lines.push("");
  lines.push(`## Dayanıklılık (${report.durabilityMinutes} dk)`);
  lines.push("");
  lines.push(`- Gözlenen güncelleme sayısı: ${report.screen.autoUpdates}`);
  lines.push("- Her sorguda yeni tarayıcı AÇILMADI; tek oturum açık tutuldu.");
  lines.push("");
  lines.push("## Notlar");
  lines.push("");
  if (report.notes.length === 0) lines.push("- (yok)");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Sınırlar");
  lines.push("");
  lines.push("- Bu veri **resmî API değildir**; ekran ve doğal oturum gözlemidir.");
  lines.push("- Genel ticari yayın için lisans konusu ayrıca çözülmelidir.");
  lines.push("- Ekran yapısı değişirse okuma fail closed olur; yanlış fiyat üretilmez.");
  if (report.botProtectionScripts.length > 0) {
    lines.push(
      `- Sayfa **${report.botProtectionScripts.join(", ")}** yüklüyor. Bu koşumda etkileşim istenmedi ve ` +
        "hiçbir koruma aşılmadı; ancak skor tabanlı koruma, sunucu tarafı sürekli bir toplayıcıyı " +
        "ileride engelleyebilir.",
    );
  }
  lines.push(
    "- **CONVENTION** eşlemeli satırlar (ÇEYREK / YARIM / TAM ALTIN) ekranda ve ağ yanıtında " +
      "yeni/eski ayrımı bulunmadığı için piyasa teamülüne göre eşlendi ve yönetici onayı " +
      "olmadan değerlemeye GİRMEZ.",
  );
  lines.push("");
  return lines.join("\n");
}

void main();
