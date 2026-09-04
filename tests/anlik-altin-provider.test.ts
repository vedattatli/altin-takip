import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnlikAltinProvider,
  parseAnlikAltinTable,
  tableContractOk,
  tableNumberFormat,
  toIsoTimestamp,
} from "@/prices/providers/anlik-altin-provider";

/**
 * ANLIK ALTIN ADAPTER'I
 *
 * Kanıtlanan şeyler:
 *  - Sayfada ÜÇ blok var; yalnızca sözleşmesi doğrulanan biri okunur.
 *  - KAYSARDER bloğu (yalnız iframe) hiçbir koşulda fiyat üretmez.
 *  - Gizli "kuyumcu" bloğu ve Kapalıçarşı tablosu birbirine KARIŞMAZ.
 *  - Nokta ondalık ayırıcıdır; binlik sanılırsa fiyat yüz katına çıkardı.
 *  - Alış/satış yönü ters çevrilmez.
 *  - Şekil değişirse fail closed olunur.
 */

const ENV_KEYS = ["APP_DEPLOYMENT_ENV", "PRICE_EXPERIMENTAL_SARRAF_SCREEN", "PRICE_EXPERIMENTAL_PRIVATE_PILOT"];

function openGate(): void {
  process.env.APP_DEPLOYMENT_ENV = "private-pilot";
  process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
  process.env.PRICE_EXPERIMENTAL_PRIVATE_PILOT = "true";
}

function clearGate(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** Satır üreticisi — gerçek sayfadaki işaretlemenin birebir aynısı. */
function row(key: string, label: string, buy: string, sell: string, time = "07:13:57"): string {
  return (
    `<tr><td><div class="ad"><a href="#">${label}</a>` +
    `<span class="time" data-kapalicarsih="${key}_zaman" style="display:block;">${time}</span></div></td>` +
    `<td><div data-name="${key}_alis">${buy}</div></td>` +
    `<td><div data-name="${key}_satis">${sell}</div></td></tr>`
  );
}

/**
 * Gerçek sayfanın yapısı: gizli kuyumcu bloğu, Kapalıçarşı tablosu ve
 * içinde SADECE iframe olan KAYSARDER bloğu.
 */
const PAGE =
  `<div data-market="3" class="hide" data-type="kuyumcu"><div class="sub">` +
  `<table class="external" id="altinkaynak" title="Altınkaynak">` +
  row("Hhas_toptan", "Has Toptan", "9999.99", "9999.99", "07:14:02") +
  row("H22_ayar_bilezik", "22 Ayar Bilezik", "226677.60", "245390.00", "07:14:02") +
  `</table></div></div>` +
  `<div data-market="5" data-type="harem"><div class="sub">` +
  `<table class="external" id="kapalicarsi_h" title="Kapalı Çarşı Altın">` +
  row("HGRAM", "Gram Altın", "6875.51", "6959.13") +
  row("HHAS", "Has Altın", "6910.06", "6945.24") +
  row("HCEYREK", "Çeyrek Altın", "11214", "11359") +
  row("HCEYREK_ESKI", "Çeyrek Eski", "11027", "11151", "07:13:54") +
  row("HYARIM", "Yarım Altın", "22456", "22691", "07:13:54") +
  row("HTEK", "Tam Altın", "44704", "45229", "07:13:54") +
  row("HATA", "Ata Altın", "45464", "46028") +
  row("HGREMSE", "Gremse (2.5)", "111242", "112692", "07:13:54") +
  row("HGUMUSTRY", "Gümüş Gram", "96.576", "103.802", "07:13:48") +
  row("HXAUXAG", "Altın/Gümüş", "66.33", "71.43", "07:13:53") +
  `</table>` +
  `<div class="info"><span class="line">Son Güncelleme: 04 Eylül 2026 ` +
  `<span class="time" data-kapalicarsih="HGRAM_zaman">07:13:59</span></span></div>` +
  `</div></div>` +
  `<div data-market="4" data-type="KAYSARDER: Kayseri Sarraflar">` +
  `<iframe src="https://tv.sarraf.pro/?mode=frame&slug=kayseri&code=383838" width="100%" height="630"></iframe>` +
  `</div>`;

function providerWith(html: string, ok = true): AnlikAltinProvider {
  return new AnlikAltinProvider({
    fetchImpl: (async () => ({ ok, text: async () => html }) as unknown as Response) as unknown as typeof fetch,
  });
}

describe("1. hangi tablo okunur", () => {
  it("yalnızca sözleşmesi doğrulanan Kapalıçarşı tablosu okunur", () => {
    const table = parseAnlikAltinTable(PAGE);
    expect(table.dataType).toBe("harem");
    expect(table.tableId).toBe("kapalicarsi_h");
    expect(tableContractOk(table)).toBe(true);
    // Gizli "kuyumcu" bloğundaki satırlar KARIŞMAZ.
    expect(table.rows.some((entry) => entry.key.startsWith("Hhas_toptan"))).toBe(false);
    expect(table.rows.some((entry) => entry.key.startsWith("H22_ayar_bilezik"))).toBe(false);
  });

  it("KAYSARDER bölümünde tek bir fiyat hücresi yoktur", () => {
    const start = PAGE.indexOf('<div data-market="4"');
    const block = PAGE.slice(start);
    expect(block).toContain("tv.sarraf.pro");
    expect(block).not.toMatch(/data-name="/u);
  });

  it("beklenen tablo yoksa BAŞKA tabloya geçilmez", () => {
    // Kapalıçarşı bloğu tamamen kaldırıldı; gizli kuyumcu tablosu duruyor.
    const withoutWide = PAGE.replace(/<div data-market="5"[\s\S]*?(?=<div data-market="4")/u, "");
    const table = parseAnlikAltinTable(withoutWide);
    expect(tableContractOk(table)).toBe(false);
    expect(table.rows).toHaveLength(0);
  });

  it("tablo kimliği değişirse fail closed olunur", () => {
    const renamed = PAGE.replace('id="kapalicarsi_h"', 'id="baska_tablo"');
    expect(tableContractOk(parseAnlikAltinTable(renamed))).toBe(false);
  });
});

describe("2. sayı biçimi", () => {
  it("nokta ONDALIK ayırıcı olarak okunur, binlik değil", () => {
    const table = parseAnlikAltinTable(PAGE);
    // Kaynakta "6875.51" var. Türkçe varsayılsaydı 687551 çıkardı.
    expect(tableNumberFormat(table.rows)).toBe("en");
  });
});

describe("3. gözlem zamanı", () => {
  it("Türkçe tarih + satır saati ISO'ya çevrilir (+03:00 varsayımıyla)", () => {
    expect(toIsoTimestamp("04 Eylül 2026", "07:13:57", "07:13:59")).toBe("2026-09-04T04:13:57.000Z");
  });

  it("gece yarısını geçen satır bir önceki güne yazılır", () => {
    // Blok 00:00:05'e dönmüş, satır hâlâ 23:59:50 → satır önceki gündür.
    expect(toIsoTimestamp("05 Eylül 2026", "23:59:50", "00:00:05")).toBe("2026-09-04T20:59:50.000Z");
  });

  it("tanınmayan ay adı kabul edilmez", () => {
    expect(toIsoTimestamp("04 Sept 2026", "07:13:57", null)).toBeNull();
  });
});

describe("4. ortam kapısı", () => {
  beforeEach(clearGate);
  afterEach(clearGate);

  /*
   * ORTAM BAYRAĞI KAPISI KALDIRILDI.
   *
   * Kaynak eskiden APP_DEPLOYMENT_ENV=private-pilot ve iki bayrak istiyordu;
   * biri eksik kalınca SESSİZCE ölüyor, kullanıcı fiyatların neden gelmediğini
   * göremiyordu. Artık kaynağı yönetici açar/kapatır (`enabled`), tek karar
   * noktası budur.
   *
   * Lisans durumu ORTAMA GÖRE DEĞİŞMEZ: yeniden yayım izni yoktur, bu bir
   * olgudur. Kaynak her ortamda lisanssız etiketlenir ve LİSANSLI SAYILMAZ.
   */
  it("lisans durumu ortam bayrağından bağımsızdır", () => {
    expect(providerWith(PAGE).licenseStatus()).toBe("EXPERIMENTAL_PRIVATE");
    openGate();
    expect(providerWith(PAGE).licenseStatus()).toBe("EXPERIMENTAL_PRIVATE");
  });

  it("bayrak olmadan da fiyat üretebilir", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    expect(snapshot.status).not.toBe("unavailable");
    expect(snapshot.quotes.length).toBeGreaterThan(0);
  });
});

describe("5. fiyat üretimi", () => {
  beforeEach(openGate);
  afterEach(clearGate);

  it("gram altın doğru büyüklükte okunur", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    const gram = snapshot.quotes.find((quote) => quote.canonicalProductId === "gram-altin");
    expect(gram?.liquidationPrice).toBe("6875.51");
    expect(gram?.replacementPrice).toBe("6959.13");
  });

  it("alış bozdurmaya, satış yeniden alıma yazılır; ters çevrilmez", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    for (const quote of snapshot.quotes) {
      expect(Number(quote.replacementPrice)).toBeGreaterThanOrEqual(Number(quote.liquidationPrice));
    }
    const ceyrek = snapshot.quotes.find((quote) => quote.canonicalProductId === "yeni-ceyrek");
    expect(ceyrek?.liquidationPrice).toBe("11214");
    expect(ceyrek?.replacementPrice).toBe("11359");
  });

  it("gümüş ve oran satırları altın ürününe YAZILMAZ", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    const ids = snapshot.quotes.map((quote) => quote.canonicalProductId);
    expect(ids.some((id) => id.includes("gumus"))).toBe(false);
    // "Altın/Gümüş" bir orandır; hiçbir ürüne eşlenmez.
    expect(snapshot.quotes.every((quote) => Number(quote.liquidationPrice) > 100)).toBe(true);
  });

  it("zaman damgası kökeni OBSERVED'dır; sağlayıcı damgası gibi sunulmaz", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    for (const quote of snapshot.quotes) {
      expect(quote.timestampProvenance).toBe("OBSERVED");
      expect(quote.providerTimestamp).not.toBeNull();
    }
  });

  it("eski çeyrek ayrı bir satırdır; yeni çeyrekten kopyalanmaz", async () => {
    const snapshot = await providerWith(PAGE).fetchSnapshot([]);
    const yeni = snapshot.quotes.find((quote) => quote.canonicalProductId === "yeni-ceyrek");
    const eski = snapshot.quotes.find((quote) => quote.canonicalProductId === "eski-ceyrek");
    expect(eski?.liquidationPrice).toBe("11027");
    expect(eski?.liquidationPrice).not.toBe(yeni?.liquidationPrice);
  });
});

describe("6. sözleşme değişirse fail closed", () => {
  beforeEach(openGate);
  afterEach(clearGate);

  it("güncelleme tarihi yoksa fiyat ÜRETİLMEZ", async () => {
    const snapshot = await providerWith(PAGE.replace(/Son Güncelleme:[^<]*/u, "")).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.safeErrorCode).toBe("CONTRACT_MISMATCH");
  });

  it("HTTP hatasında başka kaynağa DÜŞÜLMEZ", async () => {
    const snapshot = await providerWith(PAGE, false).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("alan adları değişirse esnek okuma YAPILMAZ", async () => {
    const snapshot = await providerWith(PAGE.replace(/data-name="/gu, 'data-field="')).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("satış alıştan düşükse satır ATLANIR, düzeltilmez", async () => {
    const reversed = PAGE.replace(
      '<div data-name="HGRAM_satis">6959.13</div>',
      '<div data-name="HGRAM_satis">1.00</div>',
    );
    const snapshot = await providerWith(reversed).fetchSnapshot([]);
    expect(snapshot.quotes.some((quote) => quote.canonicalProductId === "gram-altin")).toBe(false);
  });
});
