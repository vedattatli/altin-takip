import {
  type FetchOptions,
  type LicenseStatus,
  type NormalizedQuote,
  type ProviderConfigValidation,
  type ProviderSnapshot,
} from "../contract";
import { requireProviderDescriptor } from "../descriptors";
import { detectNumberFormat, parseScreenNumber, type NumberFormat } from "../number-format";
import { BaseProvider, hashPayload } from "./base";
import {
  ANLIK_ALTIN_MAPPING,
  ANLIK_ALTIN_MAPPING_VERSION,
  ANLIK_ALTIN_TABLE_CONTRACT,
  ANLIK_ALTIN_WHOLESALE_CONTRACT,
  ANLIK_ALTIN_WHOLESALE_MAPPING,
} from "./mappings";

/**
 * ANLIK ALTIN — "KAPALIÇARŞI ÖNERİLEN" TABLOSU
 *
 * DÜZ SUNUCU İSTEĞİ YETER; TARAYICI GEREKMEZ.
 * Ürün adları, alış, satış ve güncelleme zamanı ham HTML içindedir. Bu yüzden
 * bu kaynak için Playwright KULLANILMAZ.
 *
 * HANGİ TABLO OKUNUR — VE HANGİSİ ASLA OKUNMAZ
 * Sayfada üç blok vardır:
 *
 *   data-market="3"  data-type="kuyumcu"                     → gizli (class="hide"), Altınkaynak
 *   data-market="5"  data-type="harem"    id="kapalicarsi_h" → OKUNAN TABLO
 *   data-market="4"  data-type="KAYSARDER: Kayseri Sarraflar" → YALNIZCA iframe
 *
 * KAYSARDER bloğunun tamamı 257 bayttır ve içinde tek bir fiyat hücresi
 * yoktur; yalnızca `tv.sarraf.pro` penceresini gömer. Yani bu sayfadan
 * "KAYSARDER fiyatı" okumak MÜMKÜN DEĞİLDİR. Bu sınıf oradan veri okumaya
 * çalışmaz ve okuduğu veriyi Kayseri fiyatı diye etiketlemez.
 *
 * Okunacak blok üç işaretle birden doğrulanır (market numarası, `data-type`,
 * tablo kimliği). Üçünden biri tutmazsa fail closed olunur: "benzeyen" başka
 * bir tablo okunmaz.
 *
 * ANLAM
 *   `_alis`  = piyasanın ALDIĞI fiyat  = kullanıcının BOZDURMA karşılığı
 *   `_satis` = piyasanın SATTIĞI fiyat = kullanıcının YENİDEN ALIM maliyeti
 * Bu iki alan birbirine çevrilmez, türetilmez, yer değiştirmez.
 */

const ENDPOINT = "https://anlikaltinfiyatlari.com/altin/kayseri";
const STALE_AFTER_MS = 20 * 60_000;

/** Kaynağın kendini tanıtan isteği; gizlenmiş bir tarayıcı taklidi değildir. */
const USER_AGENT = "AltinTakipPilot/1.0 (+ozel pilot; fiyat okuma)";

const TURKISH_MONTHS: Readonly<Record<string, number>> = {
  ocak: 1,
  şubat: 2,
  mart: 3,
  nisan: 4,
  mayıs: 5,
  haziran: 6,
  temmuz: 7,
  ağustos: 8,
  eylül: 9,
  ekim: 10,
  kasım: 11,
  aralık: 12,
};

export interface AnlikAltinRow {
  /** `data-name` öneki — sayfanın veri sözleşmesi. Görünen başlık değildir. */
  key: string;
  /** Ekranda görünen başlık; yalnızca tanı ve rapor içindir. */
  label: string;
  buy: string;
  sell: string;
  /** Satırın kendi saati ("HH:MM:SS"), sayfada yayımlandığı gibi. */
  time: string | null;
}

export interface AnlikAltinTable {
  rows: AnlikAltinRow[];
  /** Tablo bloğunun kimlik işaretleri; sözleşme denetiminde kullanılır. */
  dataType: string | null;
  tableId: string | null;
  /** Blok altındaki "Son Güncelleme" tarihi ("04 Eylül 2026"). */
  updateDate: string | null;
  /** Blok altındaki "Son Güncelleme" saati ("07:13:59"). */
  updateTime: string | null;
}

/** İstenen `data-market` bloğunu bir sonraki bloğa (veya belge sonuna) kadar keser. */
function sliceMarketBlock(html: string, market: string): string {
  const start = html.indexOf(`<div data-market="${market}"`);
  if (start < 0) return "";
  const next = html.indexOf('<div data-market="', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}

/**
 * Sadece sözleşmesi doğrulanan bloğu ayrıştırır.
 *
 * Blok bulunamaz veya işaretler tutmazsa boş satır listesi döner; hiçbir
 * koşulda başka bir bloğa geçilmez.
 */
export function parseAnlikAltinTable(
  html: string,
  contract: { market: string; dataType: string; tableId: string } = ANLIK_ALTIN_TABLE_CONTRACT,
): AnlikAltinTable {
  const block = sliceMarketBlock(html, contract.market);
  const dataType =
    new RegExp(`<div data-market="${contract.market}"[^>]*data-type="([^"]*)"`, "u").exec(html)?.[1] ?? null;
  const tableId = /<table[^>]*id="([^"]+)"/u.exec(block)?.[1] ?? null;
  const updateDate = /Son Güncelleme:\s*(\d{1,2}\s+\p{L}+\s+\d{4})/u.exec(block)?.[1] ?? null;
  const updateTime = /Son Güncelleme:[\s\S]{0,120}?>(\d{2}:\d{2}:\d{2})</u.exec(block)?.[1] ?? null;

  const rows: AnlikAltinRow[] = [];
  for (const tableRow of block.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)) {
    const cell = tableRow[1]!;
    const priceCells = [...cell.matchAll(/data-name="([A-Za-z0-9_]+)_(alis|satis)">([^<]*)</gu)];
    if (priceCells.length === 0) continue;
    const key = priceCells[0]![1]!;
    // Aynı satırda birden çok ürün anahtarı görünüyorsa satır belirsizdir.
    if (priceCells.some((entry) => entry[1] !== key)) continue;
    const buy = priceCells.find((entry) => entry[2] === "alis")?.[3]?.trim() ?? "";
    const sell = priceCells.find((entry) => entry[2] === "satis")?.[3]?.trim() ?? "";
    const time = /data-kapalicarsih="[A-Za-z0-9_]+_zaman"[^>]*>(\d{2}:\d{2}:\d{2})</u.exec(cell)?.[1] ?? null;
    const label = (/<div class="ad">([\s\S]*?)<\/td>/u.exec(cell)?.[1] ?? "")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    rows.push({ key, label, buy, sell, time });
  }

  return { rows, dataType, tableId, updateDate, updateTime };
}

/** Blok gerçekten beklediğimiz tablo mu? Üç işaret de tutmalıdır. */
export function tableContractOk(
  table: AnlikAltinTable,
  contract: { dataType: string; tableId: string } = ANLIK_ALTIN_TABLE_CONTRACT,
): boolean {
  return table.dataType === contract.dataType && table.tableId === contract.tableId && table.rows.length > 0;
}

/**
 * Tablodaki bütün sayılara bakarak biçimi belirler.
 *
 * ÖLÇÜLDÜ: bu kaynak noktayı ONDALIK ayırıcı olarak kullanıyor ("6875.51") ve
 * binlik ayırıcı hiç kullanmıyor ("44704", "111242"). Türkçe biçim varsayılsaydı
 * gram altın 687.551 TL olarak okunurdu — yüz katı bir hata.
 *
 * Karar tek bir değere değil kaynağın tamamına bakılarak verilir; kalıplar
 * çelişirse "ambiguous" döner ve hiçbir sayı okunmaz.
 */
export function tableNumberFormat(rows: readonly AnlikAltinRow[]): NumberFormat {
  return detectNumberFormat(rows.flatMap((row) => [row.buy, row.sell]));
}

/**
 * "04 Eylül 2026" + "07:13:57" → ISO.
 *
 * Kaynak SAAT DİLİMİ yazmıyor. Türkiye yayını olduğu için +03:00 varsayılır ve
 * bu varsayım `timestampProvenance` alanında "OBSERVED" olarak işaretlenir:
 * sağlayıcının kesin damgası gibi sunulmaz.
 *
 * Gece yarısı kayması: satır saati blok saatinden 12 saatten fazla İLERİDEYSE
 * satır bir önceki güne aittir (blok tarihi yeni güne dönmüş demektir).
 */
export function toIsoTimestamp(dateText: string, rowTime: string, blockTime: string | null): string | null {
  const dateMatch = /^(\d{1,2})\s+(\p{L}+)\s+(\d{4})$/u.exec(dateText.trim());
  if (!dateMatch) return null;
  const month = TURKISH_MONTHS[dateMatch[2]!.toLocaleLowerCase("tr-TR")];
  if (month === undefined) return null;
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(rowTime);
  if (!timeMatch) return null;

  const day = Number(dateMatch[1]);
  const year = Number(dateMatch[3]);
  const seconds = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);

  let shiftDays = 0;
  if (blockTime !== null) {
    const blockMatch = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(blockTime);
    if (blockMatch) {
      const blockSeconds = Number(blockMatch[1]) * 3600 + Number(blockMatch[2]) * 60 + Number(blockMatch[3]);
      if (seconds - blockSeconds > 12 * 3600) shiftDays = -1;
    }
  }

  const iso = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}T${rowTime}+03:00`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + shiftDays * 86_400_000).toISOString();
}

export class AnlikAltinProvider extends BaseProvider {
  constructor(private readonly options: { now?: () => number; fetchImpl?: typeof fetch } = {}) {
    super({
      descriptor: requireProviderDescriptor("anlik-altin-kapalicarsi"),
      mapping: ANLIK_ALTIN_MAPPING,
      mappingVersion: ANLIK_ALTIN_MAPPING_VERSION,
    });
  }

  /**
   * Yeniden gösterim izni beyan EDİLMEMİŞTİR; kaynak LİSANSLI SAYILMAZ.
   * Bu bir olgudur ve gizlenmez: kaynak detayında "lisanslı veri değildir"
   * yazar. Ama kullanılabilirliği artık ortam bayrağına bağlı DEĞİLDİR —
   * kaynağı yönetici açar veya kapatır, tek karar noktası budur.
   */
  licenseStatus(): LicenseStatus {
    return "EXPERIMENTAL_PRIVATE";
  }

  validateConfiguration(): ProviderConfigValidation {
    // Anahtar veya adres gerektirmez: sayfa açık ve anahtarsızdır.
    return { ok: true, licenseStatus: this.licenseStatus(), issues: [] };
  }

  listSupportedProducts(): readonly string[] {
    return [...new Set([...Object.values(ANLIK_ALTIN_MAPPING), ...Object.values(ANLIK_ALTIN_WHOLESALE_MAPPING)])];
  }

  /** Zaman damgası satırın kendisindedir; tekil normalleştirme kullanılmaz. */
  normalizeQuote(): NormalizedQuote | null {
    return null;
  }

  async fetchSnapshot(_productIds: readonly string[], options: FetchOptions = {}): Promise<ProviderSnapshot> {
    const started = Date.now();
    const doFetch = this.options.fetchImpl ?? fetch;
    let html: string;

    try {
      const response = await doFetch(ENDPOINT, {
        headers: { Accept: "text/html", "User-Agent": USER_AGENT },
        signal: options.signal ?? AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return this.unavailableSnapshot("Kaynağa ulaşılamadı.", "UPSTREAM_ERROR", options, Date.now() - started);
      }
      html = await response.text();
    } catch {
      // Ağ hatası: fiyat ÜRETİLMEZ, başka kaynağa DÜŞÜLMEZ.
      return this.unavailableSnapshot("Kaynağa ulaşılamadı.", "NETWORK_ERROR", options, Date.now() - started);
    }

    const table = parseAnlikAltinTable(html);
    if (!tableContractOk(table)) {
      // Beklenen tablo bulunamadı. "Yakın görünen" başka tablo OKUNMAZ.
      return this.unavailableSnapshot(
        "Kaynak sayfasının beklenen tablosu bulunamadı.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }
    if (table.updateDate === null) {
      // Tarih okunamazsa bayatlık denetlenemez: fail closed.
      return this.unavailableSnapshot(
        "Kaynak güncelleme tarihi okunamadı.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }

    // Sayı biçimi BELGE DÜZEYİNDE, satır okunmadan ÖNCE belirlenir.
    const numberFormat = tableNumberFormat(table.rows);
    if (numberFormat === "ambiguous") {
      return this.unavailableSnapshot(
        "Kaynaktaki sayı biçimi belirsiz; yanlış fiyat üretmemek için hiçbir değer okunmadı.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }

    const ingestionRunId = options.ingestionRunId ?? null;
    const quotes: NormalizedQuote[] = [];
    const seen = new Set<string>();

    /*
     * İKİNCİ TABLO — YALNIZCA KÜLÇE.
     *
     * Ana tabloda (kapalicarsi_h) külçe satırı YOKTUR; toptan bloğunda vardır
     * ve makası %1,3 ile gerçek bir bayi makasıdır. Aynı bloktaki 18/14 ayar
     * satırları BİLEREK alınmaz: alış tarafı hurda, satış tarafı işçilikli
     * perakende olduğu için %14-18 makas veriyorlar (bkz. mappings.ts).
     *
     * Sözleşme ayrıca doğrulanır: blok işaretleri tutmazsa o tablo hiç
     * okunmaz, ana tablodan gelen fiyatlar etkilenmez.
     *
     * Bloğun KENDİ güncelleme tarihi de zorunludur: tarihsizse bayatlık
     * denetlenemez, o yüzden tablo hiç okunmaz — ana tabloya uygulanan
     * "tarih yoksa fail closed" kuralının aynısı. Külçe fiyatsız kalır;
     * ana tablodan gelen fiyatlar etkilenmez.
     */
    const wholesale = parseAnlikAltinTable(html, ANLIK_ALTIN_WHOLESALE_CONTRACT);
    const wholesaleRows =
      tableContractOk(wholesale, ANLIK_ALTIN_WHOLESALE_CONTRACT) && wholesale.updateDate !== null
        ? wholesale.rows.map((row) => ({ row, mapping: ANLIK_ALTIN_WHOLESALE_MAPPING, table: wholesale }))
        : [];

    for (const entry of [
      ...table.rows.map((row) => ({ row, mapping: ANLIK_ALTIN_MAPPING, table })),
      ...wholesaleRows,
    ]) {
      const row = entry.row;
      const productId = entry.mapping[row.key];
      // Beyaz listede olmayan sembol SESSİZCE başka ürüne yazılmaz, atlanır.
      if (productId === undefined) continue;
      if (seen.has(productId)) continue;

      const liquidation = parseScreenNumber(row.buy, numberFormat);
      const replacement = parseScreenNumber(row.sell, numberFormat);
      // İKİ YÖN DE ZORUNLU: tek yönlü satırdan çift fiyat uydurulmaz.
      if (liquidation === null || replacement === null) continue;
      // Satış < alış görünüyorsa sütunlar ters olabilir: DÜZELTİLMEZ, atlanır.
      if (Number(replacement) < Number(liquidation)) continue;

      /*
       * DAMGA HER ZAMAN SATIRIN KENDİ TABLOSUNDAN GELİR.
       *
       * Satırın kendi saati okunamazsa yedek, ait olduğu bloğun saatidir —
       * ANA tablonunki değil. Aksi halde donmuş bir blok (toptan bloğu sayfada
       * gizli, class="hide") ana tablonun taze saatiyle damgalanır ve günler
       * öncesinin külçe fiyatı "Güncel" görünürdü.
       */
      const src = entry.table;
      const rowTime = row.time ?? src.updateTime;
      if (rowTime === null || src.updateDate === null) continue;
      const observedAt = toIsoTimestamp(src.updateDate, rowTime, src.updateTime);
      if (observedAt === null) continue;

      seen.add(productId);
      quotes.push({
        canonicalProductId: productId,
        providerId: "anlik-altin-kapalicarsi",
        upstreamSourceId: "anlikaltinfiyatlari-kapalicarsi",
        marketId: "kapalicarsi",
        liquidationPrice: liquidation,
        replacementPrice: replacement,
        currency: "TRY",
        /*
         * ZAMAN DAMGASI
         *
         * Kaynak her satırın kendi saatini ve blok altında tarihi yayımlar;
         * damga tamamen bizim uydurmamız değildir ve taşınır. Ama SAAT DİLİMİ
         * yazmıyor: +03:00 varsayımı BİZİM yorumumuzdur. Bu yüzden köken
         * "UPSTREAM" değil "OBSERVED" olarak işaretlenir.
         */
        providerTimestamp: observedAt,
        timestampProvenance: "OBSERVED",
        fetchedAt: observedAt,
        status: "ok",
        staleAfterMs: STALE_AFTER_MS,
        rawPayloadHash: hashPayload(`${row.key}|${row.buy}|${row.sell}|${rowTime}`),
        mappingVersion: ANLIK_ALTIN_MAPPING_VERSION,
        licenseReference: null,
        ingestionRunId,
      });
    }

    if (quotes.length === 0) {
      return this.unavailableSnapshot(
        "Kaynakta eşlenen ürün bulunamadı.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }

    // Anlık görüntünün zamanı EN YENİ satırın zamanıdır; uydurma "şimdi" değildir.
    const newest = quotes.reduce(
      (latest, quote) => (Date.parse(quote.fetchedAt) > Date.parse(latest) ? quote.fetchedAt : latest),
      quotes[0]!.fetchedAt,
    );

    return {
      providerId: this.providerId,
      marketId: this.marketId,
      quotes,
      fetchedAt: newest,
      status: "ok",
      error: null,
      safeErrorCode: null,
      latencyMs: Date.now() - started,
    };
  }
}
