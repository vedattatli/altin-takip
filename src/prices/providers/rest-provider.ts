import {
  type FetchOptions,
  type LicenseStatus,
  type NormalizeContext,
  type NormalizedQuote,
  type ProviderConfigValidation,
  type ProviderDescriptor,
  type ProviderSnapshot,
} from "../contract";
import { BaseProvider, decimalOrNull, hashPayload, isFlagTrue, isoOrNull, readEnv } from "./base";

/**
 * Yapılandırılabilir REST sağlayıcı adapter'ı.
 *
 * Endpoint UYDURULMAZ: taban adres operatörün elindeki resmî sözleşmeden gelir
 * (`*_API_URL`). Adres yoksa sağlayıcı NOT_CONFIGURED kalır ve hiçbir istek atılmaz.
 *
 * Beklenen yanıt biçimi (belgelenmiş sözleşmeye göre esnek okunur):
 *   - dizi, ya da { data | result | items | prices: dizi }, ya da sembol anahtarlı nesne
 *   - her kayıt: sembol (symbol | code | kod | name), alış (bid | buy | alis),
 *     satış (ask | sell | satis), zaman (timestamp | time | updatedAt | tarih),
 *     isteğe bağlı bayat bayrağı (stale | isStale) ve üst kaynak (source | sourceId).
 *
 * ANLAM: bid/alış = kuyumcunun ALDIĞI fiyat = kullanıcının BOZDURMA karşılığı;
 *        ask/satış = kuyumcunun SATTIĞI fiyat = kullanıcının YENİDEN ALIM maliyeti.
 * Bu iki alan birbirine çevrilmez, türetilmez, yer değiştirmez.
 */

export interface RestProviderConfig {
  descriptor: ProviderDescriptor;
  mapping: Readonly<Record<string, string>>;
  mappingVersion: string;
  /** Taban adres ortam değişkeni (zorunlu). */
  urlEnv: string;
  /** API anahtarı ortam değişkeni (zorunlu). */
  apiKeyEnv: string;
  /** Anahtarın gönderileceği HTTP başlığı. */
  apiKeyHeader: string;
  /** Yeniden gösterim izni bayrağı (production aktivasyonu için zorunlu "true"). */
  redistributionEnv: string;
  /** Lisans referansı / katman ortam değişkeni. */
  licenseEnv: string;
  /** Ek zorunlu ortam değişkenleri (örn. piyasa kimliği). */
  extraRequiredEnv?: readonly string[];
  /** Sağlayıcının kendi upstream kaynağını seçmek için (opsiyonel). */
  sourceEnv?: string;
  staleAfterMs?: number;
}

interface RawRecord {
  [key: string]: unknown;
}

function pick(record: RawRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
    const lower = Object.keys(record).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (lower && record[lower] !== undefined && record[lower] !== null) return record[lower];
  }
  return undefined;
}

const SYMBOL_KEYS = ["symbol", "code", "kod", "name", "isim", "id"] as const;
const BID_KEYS = ["bid", "buy", "buying", "alis", "alış", "buyPrice"] as const;
const ASK_KEYS = ["ask", "sell", "selling", "satis", "satış", "sellPrice"] as const;
const TIME_KEYS = ["timestamp", "time", "updatedAt", "updated_at", "tarih", "date", "lastUpdate"] as const;
const STALE_KEYS = ["stale", "isStale", "outdated"] as const;
const SOURCE_KEYS = ["source", "sourceId", "source_id", "kaynak", "upstream"] as const;

/** Sağlayıcı yanıtını kayıt listesine çevirir (dizi, sarmalanmış dizi veya sembol anahtarlı nesne). */
export function extractRecords(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) return payload.filter((item): item is RawRecord => typeof item === "object" && item !== null);
  if (typeof payload !== "object" || payload === null) return [];
  const container = payload as RawRecord;
  for (const key of ["data", "result", "items", "prices", "quotes"]) {
    const nested = container[key];
    if (Array.isArray(nested)) {
      return nested.filter((item): item is RawRecord => typeof item === "object" && item !== null);
    }
    if (nested && typeof nested === "object") return extractRecords(nested);
  }
  // Sembol anahtarlı nesne: { "ALTIN": { bid, ask }, ... }
  const entries = Object.entries(container).filter(
    ([, value]) => typeof value === "object" && value !== null && !Array.isArray(value),
  );
  if (entries.length === 0) return [];
  return entries.map(([symbol, value]) => ({ symbol, ...(value as RawRecord) }));
}

export class RestQuoteProvider extends BaseProvider {
  constructor(private readonly config: RestProviderConfig) {
    super({
      descriptor: config.descriptor,
      mapping: config.mapping,
      mappingVersion: config.mappingVersion,
      staleAfterMs: config.staleAfterMs,
    });
  }

  private requiredEnvNames(): readonly string[] {
    return [
      this.config.urlEnv,
      this.config.apiKeyEnv,
      this.config.licenseEnv,
      ...(this.config.extraRequiredEnv ?? []),
    ];
  }

  licenseReference(): string | null {
    return readEnv(this.config.licenseEnv) || null;
  }

  licenseStatus(): LicenseStatus {
    const missing = this.missingEnv(this.requiredEnvNames());
    if (missing.length > 0) return "NOT_CONFIGURED";
    // Yeniden gösterim izni AÇIKÇA "true" değilse lisanslı sayılmaz (fail closed).
    if (!isFlagTrue(this.config.redistributionEnv)) return "LICENSE_REQUIRED";
    return "LICENSED";
  }

  validateConfiguration(): ProviderConfigValidation {
    const issues = this.missingEnv(this.requiredEnvNames());
    if (issues.length > 0) {
      return { ok: false, licenseStatus: "NOT_CONFIGURED", issues };
    }
    if (!isFlagTrue(this.config.redistributionEnv)) {
      return {
        ok: false,
        licenseStatus: "LICENSE_REQUIRED",
        issues: [
          {
            variable: this.config.redistributionEnv,
            message: `${this.config.redistributionEnv} açıkça "true" olmadan kaynak kullanıcıya sunulamaz (yeniden gösterim izni).`,
          },
        ],
      };
    }
    return { ok: true, licenseStatus: "LICENSED", issues: [] };
  }

  normalizeQuote(raw: unknown, context: NormalizeContext): NormalizedQuote | null {
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as RawRecord;
    const symbolValue = pick(record, SYMBOL_KEYS);
    if (typeof symbolValue !== "string") return null;
    const canonicalProductId = this.mapping[symbolValue] ?? this.mapping[symbolValue.toUpperCase()];
    // Eşlenmeyen sembol SESSİZCE başka ürüne yazılmaz; atlanır.
    if (!canonicalProductId) return null;

    const liquidationPrice = decimalOrNull(pick(record, BID_KEYS));
    const replacementPrice = decimalOrNull(pick(record, ASK_KEYS));
    if (!liquidationPrice || !replacementPrice) return null;

    const providerTimestamp = isoOrNull(pick(record, TIME_KEYS)) ?? context.fetchedAt;
    const staleFlag = pick(record, STALE_KEYS);
    const upstream = pick(record, SOURCE_KEYS);
    const configuredSource = this.config.sourceEnv ? readEnv(this.config.sourceEnv) : "";

    return {
      canonicalProductId,
      providerId: this.providerId,
      // Üst kaynak bilinmiyorsa null kalır; UI "Çoklu Kaynak" etiketi gösterir.
      upstreamSourceId: typeof upstream === "string" && upstream.trim() !== "" ? upstream.trim() : configuredSource || null,
      marketId: this.marketId,
      liquidationPrice,
      replacementPrice,
      currency: "TRY",
      providerTimestamp,
      fetchedAt: context.fetchedAt,
      status: staleFlag === true ? "stale" : "ok",
      staleAfterMs: this.staleAfterMs,
      rawPayloadHash: hashPayload(record),
      mappingVersion: this.mappingVersion,
      licenseReference: this.licenseReference(),
      ingestionRunId: context.ingestionRunId,
    };
  }

  async fetchSnapshot(productIds: readonly string[], options: FetchOptions = {}): Promise<ProviderSnapshot> {
    const validation = this.validateConfiguration();
    if (!validation.ok) {
      const licenseRequired = validation.licenseStatus === "LICENSE_REQUIRED";
      return this.unavailableSnapshot(
        licenseRequired
          ? "Bu kaynak için yeniden gösterim izni işaretlenmediğinden fiyat alınmıyor."
          : "Bu kaynak yapılandırılmadığı için fiyat alınmıyor.",
        licenseRequired ? "LICENSE_REQUIRED" : "NOT_CONFIGURED",
        options,
      );
    }

    const now = options.now?.() ?? Date.now();
    const fetchedAt = new Date(now).toISOString();
    const started = Date.now();
    const url = readEnv(this.config.urlEnv);
    const source = this.config.sourceEnv ? readEnv(this.config.sourceEnv) : "";
    const target = source ? `${url}${url.includes("?") ? "&" : "?"}source=${encodeURIComponent(source)}` : url;

    const response = await this.httpJson(
      target,
      {
        method: "GET",
        headers: {
          // API anahtarı YALNIZCA sunucuda; loglara ve istemciye çıkmaz.
          [this.config.apiKeyHeader]: readEnv(this.config.apiKeyEnv),
          Accept: "application/json",
        },
      },
      options,
    );
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      return {
        providerId: this.providerId,
        marketId: this.marketId,
        quotes: [],
        fetchedAt,
        status: "unavailable",
        error: response.message,
        safeErrorCode: response.code,
        latencyMs,
      };
    }

    const context: NormalizeContext = {
      fetchedAt,
      ingestionRunId: options.ingestionRunId ?? null,
      now,
    };
    const wanted = new Set(productIds);
    const quotes: NormalizedQuote[] = [];
    for (const record of extractRecords(response.data)) {
      const quote = this.normalizeQuote(record, context);
      if (!quote) continue;
      if (wanted.size > 0 && !wanted.has(quote.canonicalProductId)) continue;
      quotes.push(quote);
    }

    const requested = wanted.size > 0 ? wanted.size : quotes.length;
    const status = quotes.length === 0 ? "unavailable" : quotes.length < requested ? "partial" : "ok";
    return {
      providerId: this.providerId,
      marketId: this.marketId,
      quotes,
      fetchedAt,
      status,
      error:
        status === "unavailable"
          ? "Sağlayıcıdan eşlenebilir fiyat alınamadı."
          : status === "partial"
            ? "Bazı ürünler için fiyat alınamadı; bu ürünler değerlemeye dâhil edilmez."
            : null,
      safeErrorCode: status === "ok" ? null : status === "partial" ? "PARTIAL_COVERAGE" : "NO_MAPPED_QUOTES",
      latencyMs,
    };
  }
}
