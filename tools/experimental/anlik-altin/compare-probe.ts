/**
 * AYNI-AN KARŞILAŞTIRMASI — ANLIK ALTIN KAYSERİ ↔ SARRAF TV
 *
 *   npm run price:anlik:compare
 *
 * Bu bir DOĞRULAMA sondasıdır; değerleme yoluna girmez ve hiçbir fiyat yazmaz.
 *
 * Her gözlemde AYNI ANDA iki kaynak okunur:
 *   1. anlikaltinfiyatlari.com/altin/kayseri — düz sunucu fetch'i (ham HTML)
 *        a) data-market="5"  KAPALIÇARŞI ÖNERİLEN tablosu
 *        b) data-market="4"  KAYSARDER bölümü — içinde gerçekten sayı var mı?
 *   2. tv.sarraf.pro Kayseri ekranı — Playwright DOM okuması
 *
 * Sonra ÇEYREK / YARIM / TAM / GREMSE hücreleri kuruş kuruş karşılaştırılır.
 * Amaç tek bir soruyu kanıtla yanıtlamaktır: Anlık Altın sayfası Sarraf TV
 * ekranının bir AYNASI mı, yoksa BAŞKA bir piyasanın verisi mi?
 */
import { writeFileSync } from "node:fs";

import { chromium } from "playwright-core";

import { READ_SCREEN_SCRIPT } from "../sarraf-tv-kayseri/reader";

const PAGE_URL = "https://anlikaltinfiyatlari.com/altin/kayseri";
const SCREEN_URL = "https://tv.sarraf.pro/?mode=frame&slug=kayseri&code=383838";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface AnlikRow {
  key: string;
  label: string;
  buy: string;
  sell: string;
  time: string | null;
}

/** Bir `data-market` bloğunu bir sonraki bloğa kadar keser. */
function sliceBlock(html: string, market: string): string {
  const start = html.indexOf(`<div data-market="${market}"`);
  if (start < 0) return "";
  const next = html.indexOf('<div data-market="', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}

function dataTypeOf(html: string, market: string): string | null {
  const match = new RegExp(`<div data-market="${market}"[^>]*data-type="([^"]*)"`, "u").exec(html);
  return match?.[1] ?? null;
}

function parseWideTable(html: string): { rows: AnlikRow[]; dataType: string | null; tableId: string | null } {
  const block = sliceBlock(html, "5");
  const rows: AnlikRow[] = [];
  for (const tr of block.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)) {
    const cell = tr[1]!;
    const priceCells = [...cell.matchAll(/data-name="([A-Za-z0-9_]+)_(alis|satis)">([^<]*)</gu)];
    if (priceCells.length === 0) continue;
    const key = priceCells[0]![1]!;
    const buy = priceCells.find((entry) => entry[2] === "alis")?.[3] ?? "";
    const sell = priceCells.find((entry) => entry[2] === "satis")?.[3] ?? "";
    const time = /data-kapalicarsih="[A-Za-z0-9_]+_zaman"[^>]*>([^<]*)</u.exec(cell)?.[1] ?? null;
    const label = (/<div class="ad">([\s\S]*?)<\/td>/u.exec(cell)?.[1] ?? "")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    rows.push({ key, label, buy, sell, time });
  }
  return {
    rows,
    dataType: dataTypeOf(html, "5"),
    tableId: /<table[^>]*id="([^"]+)"/u.exec(block)?.[1] ?? null,
  };
}

function inspectKaysarder(html: string): {
  dataType: string | null;
  numericCells: number;
  iframeSrc: string | null;
  visibleText: string;
} {
  const block = sliceBlock(html, "4");
  return {
    dataType: dataTypeOf(html, "4"),
    numericCells: [...block.matchAll(/data-name="[^"]+">([^<]*)</gu)].length,
    iframeSrc: /<iframe[^>]*src="([^"]+)"/u.exec(block)?.[1] ?? null,
    visibleText: block.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim(),
  };
}

interface ScreenRow {
  label: string;
  cells: Record<string, string>;
  directionResolved: boolean;
}

interface ScreenReading {
  rows: ScreenRow[];
  headers: string[];
  signature: string;
}

async function readScreen(): Promise<ScreenReading> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(SCREEN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let reading: ScreenReading = { rows: [], headers: [], signature: "" };
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      reading = (await page.evaluate(READ_SCREEN_SCRIPT)) as ScreenReading;
      if (reading.rows.length > 0 && reading.headers.length >= 2) break;
      await page.waitForTimeout(2_000);
    }
    return reading;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const WANTED = ["ÇEYREK", "YARIM", "TAM", "GREMSE"] as const;

/** Anlık Altın tarafındaki karşılık gelen `data-name` önekleri. */
const ANLIK_KEYS: Record<(typeof WANTED)[number], string> = {
  ÇEYREK: "HCEYREK",
  YARIM: "HYARIM",
  TAM: "HTEK",
  GREMSE: "HGREMSE",
};

function normalizeLabel(value: string): string {
  return value.trim().toLocaleUpperCase("tr-TR").replace(/\s+/gu, " ");
}

function pickScreenRow(rows: readonly ScreenRow[], want: string): ScreenRow | null {
  return (
    rows.find((row) => normalizeLabel(row.label) === want) ??
    rows.find((row) => normalizeLabel(row.label) === `${want} ALTIN`) ??
    rows.find((row) => normalizeLabel(row.label).startsWith(want)) ??
    null
  );
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = value.replace(/\./gu, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

async function observe(index: number) {
  const at = new Date().toISOString();
  const [html, screen] = await Promise.all([
    fetch(PAGE_URL, { headers: { "User-Agent": UA, Accept: "text/html" } }).then((response) => response.text()),
    readScreen(),
  ]);
  const wide = parseWideTable(html);
  const kaysarder = inspectKaysarder(html);

  const comparisons = WANTED.map((want) => {
    const anlik = wide.rows.find((row) => row.key === ANLIK_KEYS[want]);
    const row = pickScreenRow(screen.rows, want);
    const screenBuy = row?.cells["ALIŞ"] ?? null;
    const screenSell = row?.cells["SATIŞ"] ?? null;
    const anlikBuy = toNumber(anlik?.buy);
    const anlikSell = toNumber(anlik?.sell);
    const scrBuy = toNumber(screenBuy);
    const scrSell = toNumber(screenSell);
    return {
      product: want,
      anlikKey: anlik?.key ?? null,
      anlikLabel: anlik?.label ?? null,
      anlikBuy: anlik?.buy ?? null,
      anlikSell: anlik?.sell ?? null,
      anlikTime: anlik?.time ?? null,
      screenLabel: row?.label ?? null,
      screenBuy,
      screenSell,
      buyMatch: anlikBuy !== null && scrBuy !== null && anlikBuy === scrBuy,
      sellMatch: anlikSell !== null && scrSell !== null && anlikSell === scrSell,
      buyDiff: anlikBuy !== null && scrBuy !== null ? Number((scrBuy - anlikBuy).toFixed(2)) : null,
      sellDiff: anlikSell !== null && scrSell !== null ? Number((scrSell - anlikSell).toFixed(2)) : null,
    };
  });

  return {
    index,
    at,
    kaysarder,
    wideTable: { dataType: wide.dataType, tableId: wide.tableId, rowCount: wide.rows.length, rows: wide.rows },
    screen: {
      signature: screen.signature,
      headers: screen.headers,
      rowCount: screen.rows.length,
      rows: screen.rows,
    },
    comparisons,
  };
}

async function main(): Promise<void> {
  const runs: Awaited<ReturnType<typeof observe>>[] = [];
  for (let index = 1; index <= 3; index += 1) {
    console.log(`\n=== GÖZLEM ${index} ===`);
    const run = await observe(index);
    runs.push(run);
    console.log(
      `KAYSARDER bölümü : data-type=${run.kaysarder.dataType} | sayısal hücre=${run.kaysarder.numericCells} | iframe=${run.kaysarder.iframeSrc}`,
    );
    console.log(
      `Geniş tablo      : data-type=${run.wideTable.dataType} | id=${run.wideTable.tableId} | satır=${run.wideTable.rowCount}`,
    );
    console.log(
      `Sarraf TV ekranı : imza=${run.screen.signature} | başlıklar=${run.screen.headers.join(",")} | satır=${run.screen.rowCount}`,
    );
    for (const comparison of run.comparisons) {
      console.log(
        `  ${comparison.product.padEnd(7)}` +
          ` anlık=${String(comparison.anlikBuy).padStart(10)}/${String(comparison.anlikSell).padStart(10)}` +
          ` sarraf=${String(comparison.screenBuy).padStart(10)}/${String(comparison.screenSell).padStart(10)}` +
          ` eşleşme=${comparison.buyMatch ? "ALIŞ" : "----"},${comparison.sellMatch ? "SATIŞ" : "-----"}` +
          ` fark=${comparison.buyDiff}/${comparison.sellDiff}`,
      );
    }
    if (index < 3) await new Promise((resolve) => setTimeout(resolve, 20_000));
  }

  const target = new URL("./compare-result.json", import.meta.url);
  writeFileSync(target, JSON.stringify(runs, null, 2));

  const cells = runs.flatMap((run) => run.comparisons).flatMap((entry) => [entry.buyMatch, entry.sellMatch]);
  const matched = cells.filter(Boolean).length;
  console.log(
    `\nKarşılaştırılan hücre: ${cells.length} | birebir eşleşen: ${matched} | uyuşmayan: ${cells.length - matched}`,
  );
  console.log(`Ayrıntı: ${target.pathname}`);
}

void main();
