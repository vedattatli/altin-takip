import {
  type FetchOptions,
  type LicenseStatus,
  type NormalizedQuote,
  type ProviderConfigValidation,
  type ProviderSnapshot,
} from "../contract";
import { requireProviderDescriptor } from "../descriptors";
import { experimentalScreenAllowed } from "../dev-gate";
import { BaseProvider, hashPayload } from "./base";
import { TRUNCGIL_GROUPED_MAPPING, TRUNCGIL_MAPPING, TRUNCGIL_MAPPING_VERSION } from "./mappings";

/**
 * TRUNCGIL AÇIK FİNANS AKIŞI — KESİN SÖZLEŞMELİ ADAPTER
 *
 * Genel `PrototypeJsonProvider` alan adlarını TAHMİN eder ve bu yüzden üretimde
 * kullanılmaz. Bu adapter ise tek bir uçtan gelen ve doğrulanmış TEK bir
 * şekli okur:
 *
 *   {
 *     "Update_Date": "2026-09-04 06:21:01",
 *     "GRA": { "Buying": 6965.69, "Selling": 6966.56, "Type": "Gold", "Change": 0.23 },
 *     ...
 *   }
 *
 * Alan adları sabittir. Şekil değişirse fail closed olunur; esnek okuma yapılmaz.
 *
 * ANLAM
 *   Buying  = piyasanın ALDIĞI fiyat  = kullanıcının BOZDURMA karşılığı
 *   Selling = piyasanın SATTIĞI fiyat = kullanıcının YENİDEN ALIM maliyeti
 * Bu iki alan birbirine çevrilmez, türetilmez, yer değiştirmez.
 *
 * ÖNEMLİ UYARI — `Type` ALANINA GÜVENİLMEZ
 * Kaynak; GUMUS, XU100, BRENT, ONS ve DBITCOIN satırlarını da `Type: "Gold"`
 * olarak etiketliyor. Bu yüzden ürün seçimi `Type` ile DEĞİL, yalnızca açık
 * beyaz liste (`TRUNCGIL_MAPPING`) ile yapılır. Listede olmayan sembol atlanır.
 *
 * NE DEĞİLDİR
 * Bu, Türkiye geneli bir piyasa referansıdır; belirli bir kuyumcunun tezgâh
 * fiyatı değildir. Gram ve has satırlarında makas çok dardır (spot bağlantılı),
 * ziynet satırlarında ise gerçek bir makas vardır. Kullanıcıya bu, kaynak
 * açıklamasında söylenir.
 */

const ENDPOINT = "https://finans.truncgil.com/v4/today.json";
const STALE_AFTER_MS = 15 * 60_000;

interface TruncgilRow {
  Buying?: unknown;
  Selling?: unknown;
  Type?: unknown;
}

/** Ondalık METİN döner; kayan noktaya çevrilmez. */
function decimalText(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value.toFixed(2);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/\./gu, "").replace(",", ".").trim();
    if (!/^\d+(\.\d+)?$/u.test(cleaned)) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed.toFixed(2);
  }
  return null;
}

/**
 * "2026-09-04 06:21:01" → ISO.
 *
 * Kaynak zaman dilimi YAZMIYOR. Türkiye yayını olduğu için +03:00 varsayılır ve
 * bu varsayım `timestampProvenance` alanında "OBSERVED" olarak işaretlenir —
 * sağlayıcının kendi damgası gibi sunulmaz.
 */
function parseUpdateDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+03:00`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export class TruncgilProvider extends BaseProvider {
  constructor(private readonly options: { now?: () => number; fetchImpl?: typeof fetch } = {}) {
    super({
      descriptor: requireProviderDescriptor("truncgil-turkiye"),
      mapping: TRUNCGIL_MAPPING,
      mappingVersion: TRUNCGIL_MAPPING_VERSION,
    });
  }

  /**
   * Yeniden gösterim izni beyan EDİLMEMİŞTİR; bu yüzden kaynak lisanslı
   * sayılmaz. Özel pilot kapısı açıkken deneysel olarak kullanılabilir.
   */
  licenseStatus(): LicenseStatus {
    return experimentalScreenAllowed() ? "EXPERIMENTAL_PRIVATE" : "NOT_CONFIGURED";
  }

  validateConfiguration(): ProviderConfigValidation {
    const allowed = experimentalScreenAllowed();
    return {
      ok: allowed,
      licenseStatus: this.licenseStatus(),
      issues: allowed
        ? []
        : [
            {
              variable: "APP_DEPLOYMENT_ENV",
              message: "Truncgil kaynağı yalnızca özel pilot ortamında kullanılabilir.",
            },
          ],
    };
  }

  listSupportedProducts(): readonly string[] {
    return [...new Set([...Object.values(TRUNCGIL_MAPPING), ...Object.values(TRUNCGIL_GROUPED_MAPPING)])];
  }

  /**
   * Bu adapter ham kayıtları TEK TEK normalleştirmez; tüm yanıtı bir bütün
   * olarak okur (zaman damgası yanıtın kökündedir, satırlarda değildir).
   */
  normalizeQuote(): NormalizedQuote | null {
    return null;
  }

  async fetchSnapshot(_productIds: readonly string[], options: FetchOptions = {}): Promise<ProviderSnapshot> {
    if (!experimentalScreenAllowed()) {
      return this.unavailableSnapshot(
        "Truncgil kaynağı bu ortamda kullanılamaz.",
        "NOT_CONFIGURED",
        options,
      );
    }

    const started = Date.now();
    const doFetch = this.options.fetchImpl ?? fetch;
    let payload: unknown;

    try {
      const response = await doFetch(ENDPOINT, {
        headers: { Accept: "application/json" },
        signal: options.signal ?? AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return this.unavailableSnapshot("Kaynağa ulaşılamadı.", "UPSTREAM_ERROR", options, Date.now() - started);
      }
      payload = await response.json();
    } catch {
      // Ağ hatası: fiyat ÜRETİLMEZ, başka kaynağa DÜŞÜLMEZ.
      return this.unavailableSnapshot("Kaynağa ulaşılamadı.", "NETWORK_ERROR", options, Date.now() - started);
    }

    if (typeof payload !== "object" || payload === null) {
      return this.unavailableSnapshot(
        "Kaynak yanıtı beklenen yapıda değil.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }

    const record = payload as Record<string, unknown>;
    const observedAt = parseUpdateDate(record.Update_Date);
    if (observedAt === null) {
      // Zaman damgası okunamadıysa bayatlık denetlenemez: fail closed.
      return this.unavailableSnapshot(
        "Kaynak güncelleme zamanı okunamadı.",
        "CONTRACT_MISMATCH",
        options,
        Date.now() - started,
      );
    }

    const ingestionRunId = options.ingestionRunId ?? null;

    const quotes: NormalizedQuote[] = [];
    const seen = new Set<string>();

    for (const [symbol, productId] of [
      ...Object.entries(TRUNCGIL_MAPPING),
      ...Object.entries(TRUNCGIL_GROUPED_MAPPING),
    ]) {
      const row = record[symbol] as TruncgilRow | undefined;
      if (typeof row !== "object" || row === null) continue;

      const liquidation = decimalText(row.Buying);
      const replacement = decimalText(row.Selling);
      // İKİ YÖN DE ZORUNLU: tek yönlü satırdan çift fiyat uydurulmaz.
      if (liquidation === null || replacement === null) continue;
      if (seen.has(productId)) continue;
      seen.add(productId);

      quotes.push({
        canonicalProductId: productId,
        providerId: "truncgil-turkiye",
        upstreamSourceId: "truncgil-v4",
        marketId: "turkiye-genel",
        liquidationPrice: liquidation,
        replacementPrice: replacement,
        currency: "TRY",
        /*
         * ZAMAN DAMGASI
         *
         * Kaynak, yanıtın kökünde KENDİ güncelleme zamanını yayımlar
         * (`Update_Date`). Bu yüzden damga tamamen bizim uydurmamız değildir
         * ve taşınır — veritabanındaki ikinci savunma hattı da fiyatın
         * zamanını bilmek zorundadır.
         *
         * Ama kaynak SAAT DİLİMİ yazmıyor; +03:00 varsayımı BİZİM
         * yorumumuzdur. Bu yüzden köken "PROVIDER" değil "OBSERVED" olarak
         * işaretlenir ve arayüzde sağlayıcının kesin damgası gibi sunulmaz.
         */
        providerTimestamp: observedAt,
        timestampProvenance: "OBSERVED",
        fetchedAt: observedAt,
        status: "ok",
        staleAfterMs: STALE_AFTER_MS,
        rawPayloadHash: hashPayload(JSON.stringify(row)),
        mappingVersion: TRUNCGIL_MAPPING_VERSION,
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

    return {
      providerId: this.providerId,
      marketId: this.marketId,
      quotes,
      fetchedAt: observedAt,
      status: "ok",
      error: null,
      safeErrorCode: null,
      latencyMs: Date.now() - started,
    };
  }
}
