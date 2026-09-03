import type { Browser, BrowserContext, Page } from "playwright-core";

import {
  extractQuotes,
  verifyNetworkAgainstScreen,
  type ExtractedQuote,
  type RawScreenRow,
} from "../../../tools/experimental/sarraf-tv-kayseri/extract";
import {
  extractNetworkPriceRows,
  isTwoSidedRow,
  type NetworkPriceRow,
} from "../../../tools/experimental/sarraf-tv-kayseri/network-contract";
import { READ_SCREEN_SCRIPT } from "../../../tools/experimental/sarraf-tv-kayseri/reader";

/**
 * Hata çökmüş bir renderer'a mı işaret ediyor?
 *
 * Playwright bu durumda "Target crashed" veya "Page crashed" der. Mesaj
 * eşlemesi kırılgan görünür ama alternatifi yok: Playwright bu koşul için
 * ayrı bir hata sınıfı yayımlamıyor. Yanlış pozitifin bedeli yalnızca
 * gereksiz bir yeniden başlatmadır; yanlış negatifin bedeli ise worker'ın
 * sonsuza kadar ölü sayfayı okumasıdır.
 */
function isCrashError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target crashed|page crashed|target closed/iu.test(message);
}

/** Ekran okuma scripti için üst sınır. DOM taraması saniyeler sürer, dakikalar değil. */
const EVALUATE_TIMEOUT_MS = 15_000;

/** Canlılık yoklaması için üst sınır. `1` değerlendirmek anında dönmelidir. */
const PROBE_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol("timed-out");

/**
 * Bir promise'i zaman aşımıyla yarıştırır.
 *
 * Gerekli çünkü çökmüş bir renderer'da `evaluate` HER ZAMAN hata atmıyor:
 * imajdaki Chromium sürümünde donuyor. Zaman aşımı olmadan worker ölü sayfada
 * sonsuza kadar askıda kalır — sessiz ve teşhis edilemez bir arıza.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** DOM'un dolmasını beklerken iki okuma arası. */
const READ_RETRY_INTERVAL_MS = 2_000;

/**
 * Satırların gelmesi için tanınan toplam süre. Gözlem yaşı sunucuda 120 sn
 * ile sınırlı olduğundan bundan uzun beklemek anlamsızdır: beklerken
 * okuduğumuz değer zaten bayat sayılırdı.
 */
const READ_ROWS_BUDGET_MS = 45_000;

/**
 * KALICI EKRAN OTURUMU
 *
 * Tek bir Chromium süreci açık tutulur; her gözlemde tarayıcı AÇILIP KAPANMAZ.
 * Sayfa yeniden yüklenmez: ekran kendi kendini günceller, biz yalnızca okuruz.
 *
 * Kanal rolleri (ölçülerek belirlendi):
 *   - Bayi fiyatı yalnızca DOM'da bulunur (sayfa tarayıcıda hesaplıyor).
 *   - REST `price/list` yanıtı açılışta bir kez gelir ve YÖN kanıtıdır
 *     (`buying` / `sales` ayrı alanlar).
 *   - WebSocket akışı yalnızca genel piyasa kurunu taşır.
 * Bu yüzden yön AÇILIŞTA doğrulanır, değerler her turda DOM'dan okunur.
 */

export interface ScreenReading {
  rows: RawScreenRow[];
  headers: string[];
  signature: string;
  bodyText: string;
  canvasCount: number;
  hiddenMoneyCount: number;
}

export interface ObservationResult {
  ok: boolean;
  reason?: "NO_ROWS" | "SIGNATURE_MISMATCH" | "CAPTCHA" | "READ_FAILED";
  quotes: ExtractedQuote[];
  unresolved: { rawProductName: string; reason: string }[];
  headers: string[];
  signature: string;
  observedAt: string;
  captchaSeen: boolean;
}

const CAPTCHA_INTERACTION_MARKERS = [
  "checking your browser",
  "are you a human",
  "robot değilim",
  "i'm not a robot",
  "doğrulamayı tamamlayın",
  "verify you are human",
];

export function interactionRequired(text: string): boolean {
  const value = text.toLocaleLowerCase("tr-TR");
  return CAPTCHA_INTERACTION_MARKERS.some((marker) => value.includes(marker));
}

export class ScreenSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Sayfa çöktü mü. Bir kez true olur; oturum yeniden kurulmadan sıfırlanmaz. */
  private crashed = false;

  private networkRows: NetworkPriceRow[] = [];
  private verifiedLabels = new Set<string>();
  private bootstrapDone = false;

  constructor(
    private readonly browser: Browser,
    private readonly targetUrl: string,
  ) {}

  get directionVerifiedLabels(): ReadonlySet<string> {
    return this.verifiedLabels;
  }

  async open(): Promise<void> {
    this.context = await this.browser.newContext({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 900 },
    });
    const page = await this.context.newPage();
    this.page = page;
    this.crashed = false;

    // Sayfa çökmesi SESSİZ bir arızadır: sayfa kapanmaz, tarayıcı bağlı kalır.
    // İşaretlenmezse worker ölü sayfayı okumaya devam eder.
    page.on("crash", () => {
      this.crashed = true;
    });

    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.includes("json")) return;
      // YALNIZCA GÖZLEM: uç bağımsız olarak çağrılmaz, gövde saklanmaz.
      void response
        .json()
        .then((body: unknown) => {
          const rows = extractNetworkPriceRows(body);
          if (rows.length > 0) this.networkRows = rows;
        })
        .catch(() => undefined);
    });

    await page.goto(this.targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(8_000);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }

  /**
   * Oturum canlı mı.
   *
   * `crashed` ayrı tutulur çünkü Chromium bir sayfa çöktüğünde onu KAPATMAZ ve
   * tarayıcı bağlantısı da kopmaz. Yalnızca `isClosed()` ve `isConnected()`
   * bakılsaydı çökmüş sayfa "canlı" görünür, worker onu sonsuza kadar okumaya
   * çalışır ve kendi kendine hiç kurtulmazdı.
   */
  get alive(): boolean {
    return this.page !== null && !this.crashed && !this.page.isClosed() && this.browser.isConnected();
  }

  /**
   * YALNIZCA DUMAN TESTİ İÇİN: renderer'ı bilerek çökertir.
   *
   * Üretim yolunda çağrılmaz. Amacı, çökme kurtarma tetikleyicisinin gerçekten
   * çalıştığını kaynak okumadan değil DAVRANIŞLA doğrulamaktır.
   */
  async crashForTest(): Promise<void> {
    if (!this.page || !this.context) return;
    // CDP `Page.crash` kullanılır. `chrome://crash` adresine gitmek işe yaramaz:
    // gerçek bir HTTPS sayfasından WebUI şemasına gidiş Chromium tarafından
    // engellenir ve renderer çökmez. CDP çağrısı doğrudan çökertir.
    const cdp = await this.context.newCDPSession(this.page);
    // `Page.crash` YANIT DÖNDÜRMEZ: hedef yanıt gönderemeden çöker, promise
    // asla çözülmez. Bu yüzden zaman aşımıyla yarıştırılır; beklemek hataysa
    // değil, tasarım gereğidir.
    await Promise.race([
      cdp.send("Page.crash").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    // Olayı beklemekle yetinilmez; her turda etkin yoklama da yapılır.
    for (let i = 0; i < 50 && !this.crashed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.probeAlive();
    }
  }

  /**
   * Renderer çöktüğünü ETKİN olarak yoklar.
   *
   * `page.on("crash")` olayına tek başına güvenilmez: olay her ortamda aynı
   * anda tetiklenmiyor (imajdaki Chromium sürümünde gecikti). Oysa çökmüş bir
   * sayfada her `evaluate` çağrısı "Target crashed" ile hata verir; bu, sürüm
   * bağımsız ve deterministik bir işarettir.
   */
  private async probeAlive(): Promise<void> {
    if (!this.page || this.crashed) return;
    try {
      const result = await withTimeout(this.page.evaluate("1"), PROBE_TIMEOUT_MS);
      // Donma da çökmedir: `1` değerlendirmek 5 saniye sürmez.
      if (result === TIMED_OUT) this.crashed = true;
    } catch (error) {
      if (isCrashError(error)) this.crashed = true;
    }
  }

  /**
   * @param deadline Okumanın bitmesi gereken an (ms). Frame başına zaman aşımı
   *   kalan süreye göre KISILIR; yoksa `frame sayısı × 15 sn` toplam bütçeyi
   *   aşar ve "toplam süre" iddiası gerçeği yansıtmaz.
   */
  private async read(deadline = Number.POSITIVE_INFINITY): Promise<ScreenReading | null> {
    if (!this.page) return null;
    let best: ScreenReading | null = null;
    let frames = 0;
    let timedOut = 0;
    for (const frame of this.page.frames()) {
      const remaining = deadline - Date.now();
      // Bütçe bittiyse kalan frame'ler denenmez; elde ne varsa onunla dönülür.
      if (remaining <= 0) break;
      frames += 1;
      let result: ScreenReading | null = null;
      try {
        const outcome = await withTimeout(
          frame.evaluate(READ_SCREEN_SCRIPT) as Promise<ScreenReading | null>,
          Math.min(EVALUATE_TIMEOUT_MS, remaining),
        );
        if (outcome === TIMED_OUT) {
          timedOut += 1;
          continue;
        }
        result = outcome;
      } catch (error) {
        // Çökme sessizce yutulmaz: yutulursa worker ölü sayfayı okumaya devam
        // eder ve kendi kendine hiç kurtulmaz.
        if (isCrashError(error)) this.crashed = true;
        continue;
      }
      if (!result) continue;
      if (best === null || result.rows.length > best.rows.length) best = result;
    }
    // Bütün frame'ler zaman aşarsa renderer yanıt vermiyor demektir.
    if (frames > 0 && timedOut === frames) this.crashed = true;
    return best;
  }

  /**
   * Satırlar dolana kadar SINIRLI süre bekler.
   *
   * Neden gerekli: sayfa fiyatları tarayıcıda hesaplayıp DOM'a yazar ve bu
   * bazen sabit bir bekleme süresinden uzun sürer. Tek seferlik okuma o
   * durumlarda boş ekranı "satır yok" sanır ve worker gereksizce fiyat
   * üretmeyi bırakır.
   *
   * Bekleme SONSUZ DEĞİLDİR: bütçe dolunca boş okuma olduğu gibi döner ve
   * çağıran fail closed davranır. CAPTCHA görülürse beklemeden çıkılır —
   * bekleyerek çözülecek bir durum değildir.
   */
  private async readWithRows(budgetMs: number): Promise<ScreenReading | null> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    let last: ScreenReading | null = null;
    for (;;) {
      last = await this.read(deadline);
      if (last === null) return null;
      if (last.rows.length > 0) return last;
      if (interactionRequired(last.bodyText)) return last;
      if (Date.now() >= deadline) return last;
      await this.page?.waitForTimeout(READ_RETRY_INTERVAL_MS);
    }
  }

  /**
   * Açılış yön doğrulaması: ekranın ALIŞ sütunu gerçekten `buying` mi?
   * Yalnızca uyuşan başlıklar NETWORK_VERIFIED sayılır.
   */
  private bootstrap(reading: ScreenReading): void {
    if (this.bootstrapDone) return;
    const twoSided = this.networkRows.filter((row) => !row.isFooter && isTwoSidedRow(row));
    if (twoSided.length === 0) return;
    const networkQuotes = extractQuotes(
      twoSided.map((row) => ({
        label: row.title,
        cells: { ALIŞ: String(row.buying), SATIŞ: String(row.sales) },
        directionResolved: true,
      })),
      "network",
      { networkVerifiedLabels: new Set(twoSided.map((row) => row.title)) },
    );
    const mismatches = verifyNetworkAgainstScreen(networkQuotes.quotes, reading.rows);
    this.verifiedLabels = new Set(
      networkQuotes.quotes
        .filter((quote) => !mismatches.some((mismatch) => mismatch.label === quote.rawProductName))
        .map((quote) => quote.rawProductName),
    );
    this.bootstrapDone = this.verifiedLabels.size > 0;
  }

  /** Tek gözlem turu. Fail closed: şüphede fiyat üretmez. */
  async observe(expectedSignature: string | null): Promise<ObservationResult> {
    // ZAMAN DAMGASI OKUMADAN SONRA ALINIR.
    //
    // Okuma satırlar dolana kadar bekleyebilir ve tek bir frame değerlendirmesi
    // zaman aşımına kadar sürebilir; bu da okumanın onlarca saniye almasına yol
    // açar. Damga baştan alınsaydı "gözlem anı" değerlerin gerçekten okunduğu
    // ana değil, beklemenin başladığı ana işaret ederdi. Sunucudaki bayatlık
    // kuralı bu damgayı kullandığı için doğru olması gerekir.
    const reading = await this.readWithRows(READ_ROWS_BUDGET_MS);
    const observedAt = new Date().toISOString();
    if (!reading) {
      return {
        ok: false,
        reason: "READ_FAILED",
        quotes: [],
        unresolved: [],
        headers: [],
        signature: "",
        observedAt,
        captchaSeen: false,
      };
    }
    if (interactionRequired(reading.bodyText)) {
      return {
        ok: false,
        reason: "CAPTCHA",
        quotes: [],
        unresolved: [],
        headers: reading.headers,
        signature: reading.signature,
        observedAt,
        captchaSeen: true,
      };
    }
    if (reading.rows.length === 0) {
      return {
        ok: false,
        reason: "NO_ROWS",
        quotes: [],
        unresolved: [],
        headers: reading.headers,
        signature: reading.signature,
        observedAt,
        captchaSeen: false,
      };
    }
    // İMZA DEĞİŞTİYSE FAIL CLOSED: ekran yapısı değişmiş olabilir, yanlış
    // fiyat göndermek yerine hiç göndermeyiz.
    if (expectedSignature !== null && reading.signature !== expectedSignature) {
      return {
        ok: false,
        reason: "SIGNATURE_MISMATCH",
        quotes: [],
        unresolved: [],
        headers: reading.headers,
        signature: reading.signature,
        observedAt,
        captchaSeen: false,
      };
    }

    this.bootstrap(reading);
    const extraction = extractQuotes(reading.rows, "dom", { networkVerifiedLabels: this.verifiedLabels });
    return {
      ok: true,
      quotes: extraction.quotes,
      unresolved: extraction.unresolved,
      headers: reading.headers,
      signature: reading.signature,
      observedAt,
      captchaSeen: false,
    };
  }
}
