/**
 * SARRAF TV KAYSERİ — TEKNİK FİZİBİLİTE ARACI (DENEYSEL, ÜRETİM DIŞI)
 *
 *   npm run price:sarraf-feasibility
 *
 * AMAÇ: KAYSARDER fiyat sayfasından açılan Kayseri canlı fiyat ekranının NORMAL
 * bir tarayıcı oturumunda güvenilir biçimde okunup okunamayacağını kanıtlamak.
 * Bu araç üretim sağlayıcı mimarisinin PARÇASI DEĞİLDİR ve kullanıcı fiyatı
 * üretmez.
 *
 * SINIRLAR (ihlal edilmez):
 *  - CAPTCHA çözülmez, atlatılmaz; CAPTCHA görülürse sonuç BLOCKED'dır.
 *  - Bot koruması aşılmaz, sahte token/cookie üretilmez.
 *  - Başkasına ait hesapla giriş yapılmaz.
 *  - Yalnızca tarayıcının normal olarak yüklediği veri gözlenir.
 *  - Gizli uç, tarayıcı dışında bağımsız API gibi yeniden KULLANILMAZ.
 *  - Veri alınamazsa başka kaynağa geçilmez, fiyat uydurulmaz.
 *  - Artefaktlara cookie/authorization/token/kişisel veri YAZILMAZ.
 *
 * Sonuç dürüstçe raporlanır: OK | BLOCKED | UNAVAILABLE | NOT_RUN.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareSnapshots,
  extractQuotes,
  verifyAgainstScreenText,
  type ExtractedQuote,
  type RawScreenRow,
} from "./extract";
import { findForbiddenTraces, mergeSummaries, summarizeRequest, type SafeRequestSummary } from "./sanitize";

const TARGET_URL = "https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri";
const ARTIFACT_DIR = join(process.cwd(), "artifacts", "sarraf-tv");
const DOC_PATH = join(process.cwd(), "docs", "SARRAF_TV_FEASIBILITY.md");

type Outcome = "OK" | "BLOCKED" | "UNAVAILABLE" | "NOT_RUN";

interface RunReport {
  outcome: Outcome;
  reason: string;
  headlessWorked: boolean | null;
  headedWorked: boolean | null;
  captchaSeen: boolean;
  channel: {
    domRows: number;
    insideIframe: boolean;
    xhrJsonResponses: number;
    webSocketFrames: number;
    canvasOnly: boolean;
    providerTimestampVisible: boolean;
    autoUpdates: number;
    /** Sayfanın yüklediği bot koruması altyapısı (etkileşim istenmese bile). */
    botProtection: string[];
  };
  snapshots: {
    at: string;
    quotes: ExtractedQuote[];
    unresolved: { rawProductName: string; reason: string }[];
    numberFormat: string;
    screenMismatches: { productId: string; field: string; expected: string; screen: string }[];
  }[];
  comparison: { pair: string; differences: number; detail: unknown }[];
  network: SafeRequestSummary[];
  durabilityMinutes: number;
  notes: string[];
}

function nowIso(): string {
  return new Date().toISOString();
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

/**
 * Sayfanın yüklediği bot koruması altyapısı.
 *
 * BUNLAR AŞILMAZ. Yalnızca varlıkları RAPORLANIR: görünmez (skor tabanlı) bir
 * reCAPTCHA bugün engellemese bile sunucu tarafı sürekli bir toplayıcı için
 * gerçek bir risktir ve karar verirken bilinmelidir.
 */
const BOT_PROTECTION_HOSTS: readonly { host: string; label: string }[] = [
  { host: "google.com/recaptcha", label: "Google reCAPTCHA" },
  { host: "gstatic.com/recaptcha", label: "Google reCAPTCHA (kaynak)" },
  { host: "hcaptcha.com", label: "hCaptcha" },
  { host: "challenges.cloudflare.com", label: "Cloudflare Turnstile / challenge" },
  { host: "arkoselabs.com", label: "Arkose Labs" },
];

const CAPTCHA_MARKERS = [
  "captcha",
  "recaptcha",
  "hcaptcha",
  "cf-challenge",
  "checking your browser",
  "are you a human",
  "doğrulama",
  "robot değilim",
];

/** Sayfa metninde bot koruması / CAPTCHA izi var mı? */
export function looksBlocked(text: string): boolean {
  const value = text.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => value.includes(marker));
}

/**
 * Tarayıcı içinde çalışan ekran okuyucu (string olarak enjekte edilir).
 *
 * Sarraf TV ekranı TABLO KULLANMAZ: yaprak düğümlerin doğrusal sırasında
 * "başlık div'i" ve ardından gelen `font-money` fiyat span'ları bulunur.
 * Okuyucu bu sırayı takip eder:
 *   - "ALIŞ" / "SATIŞ" başlıkları görülünce sütun düzeni öğrenilir.
 *   - Bir başlıktan sonraki ardışık fiyatlar o satırın hücreleridir.
 *   - Yalnızca tek fiyatı olan satırlarda yön DOĞRULANAMAZ; hücre başlığı
 *     yazılmaz ve çıkarıcı bu satırı "unresolved" sayar.
 * Böylece hiçbir yerde sıraya bakarak alış/satış tahmini yapılmaz.
 */
const READ_ROWS_SCRIPT = `(() => {
  function textOf(node) { return (node.textContent || "").replace(/\s+/g, " ").trim(); }
  function isMoney(el) {
    const cls = (el.className || "").toString();
    return cls.indexOf("font-money") >= 0 || /^[\d.,]+$/.test(textOf(el));
  }
  const leaves = [];
  document.querySelectorAll("body *").forEach((el) => {
    if (el.children.length !== 0) return;
    const txt = textOf(el);
    if (!txt) return;
    leaves.push({ text: txt, money: isMoney(el) });
  });

  const headers = [];
  const rows = [];
  let current = null;
  for (const leaf of leaves) {
    const upper = leaf.text.toLocaleUpperCase("tr-TR");
    if (!leaf.money && (upper === "ALIŞ" || upper === "SATIŞ")) {
      if (headers.indexOf(upper) < 0) headers.push(upper);
      current = null;
      continue;
    }
    if (leaf.money) {
      if (current) current.values.push(leaf.text);
      continue;
    }
    if (current && current.values.length === 0) {
      // Ardışık iki başlık: öncekinin fiyatı yok, atılır.
      rows.pop();
    }
    current = { label: leaf.text, values: [] };
    rows.push(current);
  }

  const out = [];
  for (const row of rows) {
    if (row.values.length === 0) continue;
    const cells = {};
    if (row.values.length >= 2 && headers.length >= 2) {
      cells[headers[0]] = row.values[0];
      cells[headers[1]] = row.values[1];
    } else {
      // Yön doğrulanamaz: başlıksız tek sütun.
      cells["TEK_SUTUN"] = row.values[0];
    }
    out.push({ label: row.label, cells: cells });
  }

  return {
    rows: out,
    headers: headers,
    canvasCount: document.querySelectorAll("canvas").length,
    bodyText: textOf(document.body).slice(0, 4000)
  };
})()`;

async function main(): Promise<void> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const notes: string[] = [];
  const durabilityMinutes = Number(process.env.SARRAF_FEASIBILITY_MINUTES ?? "10");
  const report: RunReport = {
    outcome: "NOT_RUN",
    reason: "",
    headlessWorked: null,
    headedWorked: null,
    captchaSeen: false,
    channel: {
      domRows: 0,
      insideIframe: false,
      xhrJsonResponses: 0,
      webSocketFrames: 0,
      canvasOnly: false,
      providerTimestampVisible: false,
      autoUpdates: 0,
      botProtection: [],
    },
    snapshots: [],
    comparison: [],
    network: [],
    durabilityMinutes,
    notes,
  };

  let chromium: typeof import("playwright-core").chromium | null = null;
  try {
    ({ chromium } = (await import("@playwright/test")) as unknown as {
      chromium: typeof import("playwright-core").chromium;
    });
  } catch {
    report.outcome = "NOT_RUN";
    report.reason = "Playwright bulunamadı; tarayıcı oturumu açılamadı.";
    finish(report);
    return;
  }

  const requests: SafeRequestSummary[] = [];
  const botProtection: string[] = [];
  let webSocketFrames = 0;
  let jsonResponses = 0;

  let browser: import("playwright-core").Browser | null = null;
  try {
    // Önce headed denenir (gerçek kullanıcı oturumuna en yakın), olmazsa headless.
    // SARRAF_FEASIBILITY_HEADLESS=1 doğrudan headless çalıştırır; bu, "headless
    // modda da okunuyor mu?" sorusunu ayrıca yanıtlamak içindir.
    const forceHeadless = process.env.SARRAF_FEASIBILITY_HEADLESS === "1";
    let headless = forceHeadless;
    if (forceHeadless) {
      browser = await chromium.launch({ headless: true });
      report.headedWorked = null;
    } else {
      try {
        browser = await chromium.launch({ headless: false });
        report.headedWorked = true;
      } catch {
        notes.push("Headed tarayıcı açılamadı (görüntü sunucusu yok); headless denendi.");
        report.headedWorked = false;
        headless = true;
        browser = await chromium.launch({ headless: true });
      }
    }
    report.headlessWorked = headless ? true : null;

    const context = await browser.newContext({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? null;
      const rawUrl = response.url();
      for (const marker of BOT_PROTECTION_HOSTS) {
        if (rawUrl.includes(marker.host) && !botProtection.includes(marker.label)) {
          botProtection.push(marker.label);
        }
      }
      const summary = summarizeRequest(
        rawUrl,
        response.request().method(),
        response.request().resourceType(),
        response.status(),
        contentType,
      );
      if (summary) requests.push(summary);
      if (contentType && contentType.includes("json")) jsonResponses += 1;
    });
    page.on("websocket", (socket) => {
      // Yalnızca çerçeve SAYISI tutulur; içerik artefakta yazılmaz.
      socket.on("framereceived", () => {
        webSocketFrames += 1;
      });
    });

    let loaded = false;
    try {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      loaded = true;
    } catch (error) {
      report.outcome = "UNAVAILABLE";
      report.reason = `Sayfa yüklenemedi: ${error instanceof Error ? error.name : "bilinmeyen hata"}.`;
    }

    if (loaded) {
      await page.waitForTimeout(5_000);

      const takeSnapshot = async (index: number) => {
        // Ana sayfa ve iframe'lerin hepsi denenir; ilk dolu sonuç kullanılır.
        let rows: RawScreenRow[] = [];
        let canvasCount = 0;
        let bodyText = "";
        let method = "dom";
        // Hangi çerçevenin veriyi verdiği ÖLÇÜLÜR. Sayfada birden çok iframe
        // bulunabilir (ör. bot koruması); "iframe var" demek "fiyat iframe'de"
        // demek değildir.
        let fromMainFrame = false;
        for (const frame of page.frames()) {
          const result = (await frame.evaluate(READ_ROWS_SCRIPT).catch(() => null)) as {
            rows: RawScreenRow[];
            canvasCount: number;
            bodyText: string;
          } | null;
          if (!result) continue;
          canvasCount += result.canvasCount;
          if (bodyText === "") bodyText = result.bodyText;
          if (result.rows.length > rows.length) {
            rows = result.rows;
            fromMainFrame = frame === page.mainFrame();
            method = fromMainFrame ? "dom" : "iframe-dom";
          }
        }
        if (looksBlocked(bodyText)) {
          report.captchaSeen = true;
        }
        if (rows.length > 0) report.channel.insideIframe = !fromMainFrame;
        report.channel.canvasOnly = rows.length === 0 && canvasCount > 0;
        report.channel.providerTimestampVisible = /\d{2}[:.]\d{2}/u.test(bodyText);

        const extraction = extractQuotes(rows, method);
        // EKRAN ↔ JSON: çıkarılan her değer ekrandaki ham metinle karşılaştırılır.
        const mismatches = verifyAgainstScreenText(extraction.quotes, rows);
        report.channel.domRows = Math.max(report.channel.domRows, rows.length);
        const at = nowIso();
        report.snapshots.push({
          at,
          quotes: extraction.quotes,
          unresolved: extraction.unresolved,
          numberFormat: extraction.numberFormat,
          screenMismatches: mismatches,
        });

        const file = join(ARTIFACT_DIR, `snapshot-0${index}.json`);
        writeSafe(
          file,
          JSON.stringify(
            {
              observedAt: at,
              sourceUrl: TARGET_URL,
              extractionMethod: method,
              numberFormat: extraction.numberFormat,
              domRowCount: rows.length,
              screenRows: rows,
              quotes: extraction.quotes,
              unresolved: extraction.unresolved,
              screenMismatches: mismatches,
            },
            null,
            2,
          ),
          notes,
        );
        await page
          .screenshot({ path: join(ARTIFACT_DIR, `screenshot-0${index}.png`), fullPage: true })
          .catch(() => notes.push(`Ekran görüntüsü alınamadı (#${index}).`));
      };

      await takeSnapshot(1);

      if (report.captchaSeen) {
        report.outcome = "BLOCKED";
        report.reason = "Sayfada CAPTCHA / bot koruması görüldü. Aşma girişiminde BULUNULMADI.";
      } else {
        // Dayanıklılık gözlemi: aynı oturum açık kalır, sayfa yenilenmez.
        const totalMs = Math.max(1, durabilityMinutes) * 60_000;
        const step = Math.floor(totalMs / 2);
        let previousText = JSON.stringify(report.snapshots[0]?.quotes ?? []);
        const started = Date.now();
        while (Date.now() - started < totalMs) {
          await page.waitForTimeout(Math.min(30_000, step));
          // Satırları veren çerçevenin hepsini tara: fiyat ana sayfada da,
          // bir iframe'de de olabilir.
          let current: RawScreenRow[] = [];
          for (const frame of page.frames()) {
            const result = (await frame.evaluate(READ_ROWS_SCRIPT).catch(() => null)) as {
              rows: RawScreenRow[];
            } | null;
            if (result && result.rows.length > current.length) current = result.rows;
          }
          if (current.length === 0) continue;
          const text = JSON.stringify(extractQuotes(current, "dom").quotes);
          if (text !== previousText) {
            report.channel.autoUpdates += 1;
            previousText = text;
          }
          if (Date.now() - started >= step && report.snapshots.length === 1) await takeSnapshot(2);
        }
        if (report.snapshots.length === 1) await takeSnapshot(2);
        await takeSnapshot(3);

        const total = report.snapshots.reduce((sum, snapshot) => sum + snapshot.quotes.length, 0);
        const mismatchTotal = report.snapshots.reduce(
          (sum, snapshot) => sum + snapshot.screenMismatches.length,
          0,
        );
        if (total === 0) {
          report.outcome = "UNAVAILABLE";
          report.reason =
            "Ekrandan hiçbir ürün okunamadı (satır bulunamadı, canvas tabanlı olabilir veya içerik yüklenmedi).";
        } else if (mismatchTotal > 0) {
          // TEK bir ürünün alış/satışı bile ekranla uyuşmuyorsa PoC BAŞARISIZDIR.
          report.outcome = "UNAVAILABLE";
          report.reason = `Ekranda görünen değerlerle çıkarılan JSON ${mismatchTotal} noktada uyuşmadı; kısmi başarı tam başarı sayılmaz.`;
        } else {
          report.outcome = "OK";
          report.reason = "Ekran normal tarayıcı oturumunda okunabildi ve değerler birebir doğrulandı.";
        }
      }

      for (let index = 1; index < report.snapshots.length; index += 1) {
        const previous = report.snapshots[index - 1]!;
        const current = report.snapshots[index]!;
        const differences = compareSnapshots(previous.quotes, current.quotes);
        report.comparison.push({
          pair: `${index}-${index + 1}`,
          differences: differences.length,
          detail: differences.slice(0, 20),
        });
      }
    }
  } catch (error) {
    report.outcome = report.outcome === "NOT_RUN" ? "UNAVAILABLE" : report.outcome;
    report.reason = report.reason || `Beklenmeyen hata: ${error instanceof Error ? error.name : "bilinmiyor"}.`;
  } finally {
    await browser?.close().catch(() => undefined);
  }

  report.channel.xhrJsonResponses = jsonResponses;
  report.channel.webSocketFrames = webSocketFrames;
  report.channel.botProtection = botProtection;
  report.network = mergeSummaries(requests);
  finish(report);
}

function finish(report: RunReport): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeSafe(
    join(ARTIFACT_DIR, "sanitized-network-summary.json"),
    JSON.stringify({ generatedAt: nowIso(), target: TARGET_URL, requests: report.network }, null, 2),
    report.notes,
  );
  writeSafe(
    join(ARTIFACT_DIR, "comparison-report.json"),
    JSON.stringify(
      {
        generatedAt: nowIso(),
        outcome: report.outcome,
        reason: report.reason,
        snapshots: report.snapshots.map((snapshot) => ({
          at: snapshot.at,
          quoteCount: snapshot.quotes.length,
          unresolved: snapshot.unresolved,
        })),
        comparison: report.comparison,
      },
      null,
      2,
    ),
    report.notes,
  );
  writeSafe(DOC_PATH, renderDoc(report), report.notes);

  console.log("");
  console.log("== Sarraf TV Kayseri fizibilitesi ==");
  console.log(`Sonuç      : ${report.outcome}`);
  console.log(`Açıklama   : ${report.reason}`);
  console.log(`Headed     : ${report.headedWorked === null ? "denenmedi" : report.headedWorked ? "açıldı" : "açılamadı"}`);
  console.log(`Headless   : ${report.headlessWorked === null ? "denenmedi" : "çalıştı"}`);
  console.log(`CAPTCHA    : ${report.captchaSeen ? "ETKİLEŞİM İSTENDİ (aşılmadı)" : "etkileşim istenmedi"}`);
  console.log(
    `Bot koruma : ${report.channel.botProtection.length > 0 ? report.channel.botProtection.join(", ") : "tespit edilmedi"}`,
  );
  console.log(`DOM satırı : ${report.channel.domRows}`);
  console.log(`JSON yanıt : ${report.channel.xhrJsonResponses}`);
  console.log(`WS çerçeve : ${report.channel.webSocketFrames}`);
  console.log(`Güncelleme : ${report.channel.autoUpdates}`);
  for (const note of report.notes) console.log(`Not        : ${note}`);
  if (report.outcome !== "OK") {
    console.log("");
    console.log("Bu bir başarısızlık DEĞİL, dürüst bir sonuçtur: gerçek fiyat okunamadı.");
    console.log("Başka kaynağa geçilmedi ve fiyat uydurulmadı.");
  }
  // Fizibilite sonucu "geçti/kaldı" değildir; araç her durumda 0 ile biter ve
  // karar raporu okuyan insana bırakılır.
  process.exit(0);
}

function renderDoc(report: RunReport): string {
  const lines: string[] = [];
  lines.push("# Sarraf TV Kayseri — Teknik Fizibilite Raporu");
  lines.push("");
  lines.push("> Bu rapor otomatik üretilir (`npm run price:sarraf-feasibility`).");
  lines.push("> Araç deneyseldir, üretim sağlayıcı mimarisinin parçası DEĞİLDİR ve");
  lines.push("> kullanıcıya fiyat üretmez. CAPTCHA aşılmaz, bot koruması delinmez.");
  lines.push("");
  lines.push(`- **Çalıştırma zamanı:** ${nowIso()}`);
  lines.push(`- **Hedef:** \`${TARGET_URL}\``);
  lines.push(`- **Sonuç:** \`${report.outcome}\``);
  lines.push(`- **Açıklama:** ${report.reason}`);
  lines.push("");
  lines.push("## Teknik kanal");
  lines.push("");
  lines.push("| Soru | Yanıt |");
  lines.push("| --- | --- |");
  lines.push(`| Fiyatlar DOM'da mı? | ${report.channel.domRows > 0 ? `Evet (${report.channel.domRows} satır)` : "Hayır"} |`);
  lines.push(`| iframe içinde mi? | ${report.channel.insideIframe ? "Evet" : "Hayır"} |`);
  lines.push(`| XHR/fetch JSON yanıtı | ${report.channel.xhrJsonResponses} |`);
  lines.push(`| WebSocket çerçevesi | ${report.channel.webSocketFrames} |`);
  lines.push(`| Canvas tabanlı mı? | ${report.channel.canvasOnly ? "Evet (DOM'da metin yok)" : "Hayır"} |`);
  lines.push(`| Kaynak zaman damgası görünüyor mu? | ${report.channel.providerTimestampVisible ? "Evet" : "Hayır"} |`);
  lines.push(`| Otomatik güncelleme (gözlem süresince) | ${report.channel.autoUpdates} |`);
  lines.push(`| Headless çalıştı mı? | ${report.headlessWorked === null ? "denenmedi" : "evet"} |`);
  lines.push(`| CAPTCHA / etkileşim gerekti mi? | ${report.captchaSeen ? "EVET (aşılmadı)" : "hayır"} |`);
  lines.push(
    `| Sayfanın yüklediği bot koruması | ${report.channel.botProtection.length > 0 ? report.channel.botProtection.join(", ") : "tespit edilmedi"} |`,
  );
  lines.push("");
  lines.push("## Okunan ürünler");
  lines.push("");
  if (report.snapshots.length === 0) {
    lines.push("Hiç gözlem alınamadı.");
  } else {
    for (const [index, snapshot] of report.snapshots.entries()) {
      lines.push(`### Gözlem ${index + 1} — ${snapshot.at}`);
      lines.push("");
      if (snapshot.quotes.length === 0) {
        lines.push("Okunabilen ürün yok.");
      } else {
        lines.push(
          "| Ekran başlığı | Kanonik ürün | Eşleme güveni | Alış sütunu | Satış sütunu | Bozdurma | Yeniden alım |",
        );
        lines.push("| --- | --- | --- | --- | --- | --- | --- |");
        for (const quote of snapshot.quotes) {
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
    for (const item of report.comparison) {
      lines.push(`- Gözlem ${item.pair}: ${item.differences} fark`);
    }
  }
  lines.push("");
  lines.push(`## Dayanıklılık (${report.durabilityMinutes} dk)`);
  lines.push("");
  lines.push(`- Gözlenen güncelleme sayısı: ${report.channel.autoUpdates}`);
  lines.push("- Her sorguda yeni tarayıcı AÇILMADI; tek oturum açık tutuldu.");
  lines.push("");
  lines.push("## Notlar");
  lines.push("");
  if (report.notes.length === 0) lines.push("- (yok)");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Sınırlar");
  lines.push("");
  lines.push("- Bu veri **resmî API değildir**; ekran gözlemidir.");
  if (report.channel.botProtection.length > 0) {
    lines.push(
      `- Sayfa **${report.channel.botProtection.join(", ")}** yüklüyor. Bu koşumda etkileşim istenmedi ve ` +
        "hiçbir koruma aşılmadı; ancak skor tabanlı koruma, sunucu tarafı sürekli bir toplayıcıyı " +
        "ileride engelleyebilir. Kalıcı kullanım kararında bu risk hesaba katılmalıdır.",
    );
  }
  lines.push("- Genel ticari yayın için lisans konusu ayrıca çözülmelidir.");
  lines.push("- Ekran yapısı değişirse okuma fail closed olur; yanlış fiyat üretilmez.");
  lines.push(
    "- **CONVENTION** eşlemeli satırlar (ÇEYREK / YARIM / TAM ALTIN) ekranda yeni/eski ayrımı " +
      "yazmadığı için piyasa teamülüne göre yeni ürüne eşlendi. Bu satırlar teyit alınmadan " +
      "üretimde kullanılmaz.",
  );
  lines.push(
    "- Tek fiyatlı satırlarda (HAS, 22/14/8 AYAR) alış mı satış mı olduğu ekranda YAZMIYOR; " +
      "sıraya bakarak tahmin yapılmadı ve bu satırlar atlandı.",
  );
  lines.push("");
  return lines.join("\n");
}

void main();
