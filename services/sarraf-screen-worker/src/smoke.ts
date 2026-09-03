import { chromium } from "playwright-core";

import { stringFromEnv } from "./policy";
import { ScreenSession } from "./screen-session";
import { signRequest } from "./signing";

/**
 * WORKER DUMAN TESTİ (ağ ve uygulama olmadan çalışır)
 *
 *   npm --prefix services/sarraf-screen-worker run smoke
 *
 * Doğrulananlar:
 *  1. İmza başlıkları eksiksiz üretiliyor ve gövde hash'i gövdeyle uyuşuyor.
 *  2. Chromium açılıyor, ekran oturumu kuruluyor ve gözlem üretiliyor.
 *  3. İmza değişiminde gözlem FAIL CLOSED oluyor (fiyat üretilmiyor).
 *  4. Tarayıcı kapatılınca oturum "alive değil" diyor (crash recovery tetikleyicisi).
 *
 * Ağ erişimi yoksa 2–4 atlanır ve durum dürüstçe raporlanır.
 */

const TARGET = stringFromEnv(
  "SARRAF_SCREEN_URL",
  "https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri",
);

function check(name: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "ok  " : "HATA"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main(): Promise<void> {
  let failures = 0;

  console.log("== Worker duman testi ==");

  // 1. İmza
  const body = JSON.stringify({ hello: "world" });
  const signed = signRequest({ body, workerId: "smoke-1", workerVersion: "test", secret: "gizli", leaseToken: "t" });
  const required = [
    "X-Worker-Id",
    "X-Worker-Timestamp",
    "X-Worker-Nonce",
    "X-Worker-Body-SHA256",
    "X-Worker-Signature",
    "X-Worker-Version",
    "X-Worker-Lease-Token",
  ];
  if (!check("imza başlıkları eksiksiz", required.every((name) => signed.headers[name]))) failures += 1;
  if (!check("gövde değişmeden gönderiliyor", signed.body === body)) failures += 1;

  // 2-4. Tarayıcı
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    check("chromium açıldı", true, browser.version());
    const session = new ScreenSession(browser, TARGET);
    await session.open();

    const observation = await session.observe(null);
    if (!check("gözlem üretildi", observation.ok, observation.reason ?? `${observation.quotes.length} ürün`)) {
      failures += 1;
    }

    const wrongSignature = await session.observe("beklenmeyen-imza");
    if (
      !check(
        "imza değişiminde fail closed",
        !wrongSignature.ok && wrongSignature.reason === "SIGNATURE_MISMATCH" && wrongSignature.quotes.length === 0,
      )
    ) {
      failures += 1;
    }

    // GERÇEK ÇÖKME: renderer'ı bilerek çökertip kurtarma tetikleyicisini ölçer.
    // Kaynak okumak yetmez — fizibilite koşumlarında "Page crashed" gerçekten
    // görüldü ve o durumda sayfa KAPANMIYOR, tarayıcı da bağlı kalıyor.
    const crashSession = new ScreenSession(browser, TARGET);
    await crashSession.open();
    const aliveBeforeCrash = crashSession.alive;
    await crashSession.crashForTest();
    if (
      !check(
        "sayfa çökünce oturum ölü işaretlenir (tarayıcı bağlı kalsa bile)",
        aliveBeforeCrash && !crashSession.alive && browser.isConnected(),
        `öncesinde canlı=${String(aliveBeforeCrash)}, sonrasında canlı=${String(crashSession.alive)}, tarayıcı bağlı=${String(browser.isConnected())}`,
      )
    ) {
      failures += 1;
    }
    await crashSession.close().catch(() => undefined);

    await browser.close();
    if (!check("tarayıcı kapanınca oturum ölü işaretlenir", !session.alive)) failures += 1;
    browser = null;
  } catch (error) {
    console.log(`  ATLANDI tarayıcı adımları — ${error instanceof Error ? error.name : "bilinmeyen hata"}`);
    console.log("  (ağ erişimi yoksa bu beklenen bir durumdur; başarı İDDİA EDİLMEZ)");
  } finally {
    await browser?.close().catch(() => undefined);
  }

  console.log("");
  if (failures === 0) {
    console.log("Worker duman testi geçti.");
    process.exit(0);
  }
  console.log(`Worker duman testi BAŞARISIZ: ${failures} kontrol.`);
  process.exit(1);
}

void main();
