import { getProviderDescriptor, requireProviderDescriptor } from "../descriptors";
import { DEV_ONLY_BLOCKED_MESSAGE, devOnlyProviderBlocked } from "../dev-gate";
import {
  type CanonicalPriceProvider,
  type FetchOptions,
  type LicenseStatus,
  type NormalizeContext,
  type NormalizedQuote,
  type ProviderConfigValidation,
  type ProviderId,
  type ProviderSnapshot,
} from "../contract";
import { MockPriceProvider } from "../mock-provider";
import { BaseProvider, DisabledProvider, hashPayload, isFlagTrue, readEnv } from "./base";
import {
  ALTINAPI_MAPPING,
  ALTINAPI_MAPPING_VERSION,
  HASFIYAT_MAPPING,
  HASFIYAT_MAPPING_VERSION,
  SARRAFPRO_MAPPING,
  SARRAFPRO_MAPPING_VERSION,
} from "./mappings";
import { RestQuoteProvider } from "./rest-provider";

/**
 * SAĞLAYICI FABRİKASI
 *
 * Her sağlayıcı kendi lisans ve yapılandırma durumunu ortam değişkenlerinden
 * hesaplar. Hiçbir sağlayıcı, sözleşmesi ve izni olmadan veri çekmez.
 */

/** Test verisi sağlayıcısı — yalnızca geliştirme/test. Üretimde kayıt dışıdır. */
export class MockCanonicalProvider extends BaseProvider {
  private readonly inner: MockPriceProvider;

  constructor(options: { now?: () => number; unavailableProducts?: readonly string[] } = {}) {
    super({
      descriptor: requireProviderDescriptor("mock"),
      mapping: {},
      mappingVersion: "mock-1",
    });
    this.inner = new MockPriceProvider({
      now: options.now,
      unavailableProducts: options.unavailableProducts,
    });
  }

  licenseStatus(): LicenseStatus {
    return "DEV_ONLY";
  }

  validateConfiguration(): ProviderConfigValidation {
    // Üretimde test sağlayıcısı geçerli bir yapılandırma sayılmaz.
    const blocked = devOnlyProviderBlocked();
    return {
      ok: !blocked,
      licenseStatus: "DEV_ONLY",
      issues: blocked ? [{ variable: "NODE_ENV", message: DEV_ONLY_BLOCKED_MESSAGE }] : [],
    };
  }

  listSupportedProducts(): readonly string[] {
    return [];
  }

  normalizeQuote(raw: unknown, context: NormalizeContext): NormalizedQuote | null {
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const productId = record.productId;
    const liquidationPrice = record.liquidationPrice;
    const replacementPrice = record.replacementPrice;
    if (typeof productId !== "string" || typeof liquidationPrice !== "string" || typeof replacementPrice !== "string") {
      return null;
    }
    return {
      canonicalProductId: productId,
      providerId: "mock",
      upstreamSourceId: null,
      marketId: "test",
      liquidationPrice,
      replacementPrice,
      currency: "TRY",
      providerTimestamp: typeof record.providerTimestamp === "string" ? record.providerTimestamp : context.fetchedAt,
      fetchedAt: context.fetchedAt,
      status: "ok",
      staleAfterMs: this.staleAfterMs,
      rawPayloadHash: hashPayload(record),
      mappingVersion: this.mappingVersion,
      licenseReference: null,
      ingestionRunId: context.ingestionRunId,
    };
  }

  async fetchSnapshot(productIds: readonly string[], options: FetchOptions = {}): Promise<ProviderSnapshot> {
    if (devOnlyProviderBlocked()) {
      return this.unavailableSnapshot(DEV_ONLY_BLOCKED_MESSAGE, "MOCK_DISABLED_IN_PRODUCTION", options);
    }
    const started = Date.now();
    const snapshot = await this.inner.getQuotes(productIds);
    const context: NormalizeContext = {
      fetchedAt: snapshot.fetchedAt,
      ingestionRunId: options.ingestionRunId ?? null,
      now: options.now?.() ?? Date.now(),
    };
    const quotes = Object.values(snapshot.quotes)
      .map((quote) => this.normalizeQuote(quote, context))
      .filter((quote): quote is NormalizedQuote => quote !== null);
    return {
      providerId: "mock",
      marketId: "test",
      quotes,
      fetchedAt: snapshot.fetchedAt,
      status: snapshot.status,
      error: snapshot.error,
      safeErrorCode: snapshot.status === "ok" ? null : "PARTIAL_COVERAGE",
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Kayseri yerel piyasa (Sarraf Pro / KAYSARDER).
 * KAYSARDER sayfası scrape EDİLMEZ; tv.sarraf.pro trafiği reverse engineer EDİLMEZ.
 * Yalnızca yetkili API/XML sözleşmesi ile verilen adres ve anahtar kullanılır.
 */
export function createSarrafProProvider(): CanonicalPriceProvider {
  return new RestQuoteProvider({
    descriptor: requireProviderDescriptor("sarraf-pro-kayseri"),
    mapping: SARRAFPRO_MAPPING,
    mappingVersion: SARRAFPRO_MAPPING_VERSION,
    urlEnv: "SARRAFPRO_API_URL",
    apiKeyEnv: "SARRAFPRO_API_KEY",
    apiKeyHeader: "X-API-Key",
    redistributionEnv: "SARRAFPRO_REDISTRIBUTION_ALLOWED",
    licenseEnv: "SARRAFPRO_LICENSE_REFERENCE",
    extraRequiredEnv: ["SARRAFPRO_MARKET_ID"],
  });
}

/** AltinAPI — bağımsız veri sağlayıcısı (Harem Altın'ın resmî servisi DEĞİLDİR). */
export function createAltinApiProvider(): CanonicalPriceProvider {
  return new RestQuoteProvider({
    descriptor: requireProviderDescriptor("altinapi"),
    mapping: ALTINAPI_MAPPING,
    mappingVersion: ALTINAPI_MAPPING_VERSION,
    urlEnv: "ALTINAPI_API_URL",
    apiKeyEnv: "ALTINAPI_API_KEY",
    apiKeyHeader: "X-API-Key",
    redistributionEnv: "ALTINAPI_REDISTRIBUTION_ALLOWED",
    licenseEnv: "ALTINAPI_LICENSE_TIER",
  });
}

/** Hasfiyat — çoklu kaynak birleşimi; tek bir kurumun fiyatı gibi etiketlenmez. */
export function createHasfiyatProvider(): CanonicalPriceProvider {
  return new RestQuoteProvider({
    descriptor: requireProviderDescriptor("hasfiyat"),
    mapping: HASFIYAT_MAPPING,
    mappingVersion: HASFIYAT_MAPPING_VERSION,
    urlEnv: "HASFIYAT_API_URL",
    apiKeyEnv: "HASFIYAT_API_KEY",
    apiKeyHeader: "X-API-Key",
    redistributionEnv: "HASFIYAT_REDISTRIBUTION_ALLOWED",
    licenseEnv: "HASFIYAT_LICENSE_REFERENCE",
    sourceEnv: "HASFIYAT_SOURCE",
  });
}

/** Yalnızca metadata: resmî sözleşme ve izin gelene kadar kapalı. */
export function createAltinkaynakDirectProvider(): CanonicalPriceProvider {
  return new DisabledProvider(requireProviderDescriptor("altinkaynak-direct"), "LICENSE_REQUIRED");
}

export function createHaremDirectProvider(): CanonicalPriceProvider {
  return new DisabledProvider(requireProviderDescriptor("harem-direct"), "LICENSE_REQUIRED");
}

/**
 * BIST referans sağlayıcısı.
 * REFERENCE_ONLY: değerlemede birincil kaynak OLAMAZ; yerel ziynet bozdurma
 * hesabında kullanılmaz. Yalnızca sapma/sağlık kontrolü içindir.
 */
export function createBistReferenceProvider(): CanonicalPriceProvider {
  return new DisabledProvider(requireProviderDescriptor("bist-reference"), "LICENSE_REQUIRED");
}

export function createProvider(providerId: string): CanonicalPriceProvider | null {
  if (!getProviderDescriptor(providerId)) return null;
  switch (providerId as ProviderId) {
    case "mock":
      return new MockCanonicalProvider({
        unavailableProducts: (process.env.PRICE_MOCK_UNAVAILABLE_PRODUCTS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      });
    case "sarraf-pro-kayseri":
      return createSarrafProProvider();
    case "altinapi":
      return createAltinApiProvider();
    case "hasfiyat":
      return createHasfiyatProvider();
    case "altinkaynak-direct":
      return createAltinkaynakDirectProvider();
    case "harem-direct":
      return createHaremDirectProvider();
    case "bist-reference":
      return createBistReferenceProvider();
    default:
      return null;
  }
}

export { BaseProvider, DisabledProvider, RestQuoteProvider, isFlagTrue, readEnv };
