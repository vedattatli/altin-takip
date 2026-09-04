import { numberFromEnv } from "@/lib/env";
import "server-only";

import { randomUUID } from "node:crypto";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { NormalizedQuote, ProviderId } from "@/prices/contract";
import { devOnlyProviderBlocked } from "@/prices/dev-gate";
import { getProviderInstance, listProviderDescriptors } from "@/prices/registry";
import { evaluateSnapshot, type QuoteRejectionCode } from "@/prices/quality";
import type { AuthBackend } from "@/server/auth/backend";
import type { IngestionPayload, IngestionResult, ProviderSyncInput } from "./types";

/**
 * MERKEZİ FİYAT ALIMI
 *
 * Kullanıcının tarayıcısı sağlayıcıya BAĞLANMAZ. Akış:
 *   Sağlayıcı → sunucu ingestion → doğrulama/karantina → kanonik eşleme
 *   → current_price_quotes + history → kullanıcı uygulaması
 *
 * - API anahtarı yalnızca sunucudadır ve loglanmaz.
 * - Aynı sağlayıcı için iki koşum paralel çalışmaz (RPC içinde advisory lock).
 * - Aynı koşum anahtarı iki kez uygulanmaz (idempotent).
 * - Şüpheli quote değerlemeye girmez; karantinaya alınır ve raporlanır.
 */

export const MIN_INGESTION_INTERVAL_MS = 15_000;
export const MAX_INGESTION_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_INGESTION_INTERVAL_MS = 60_000;

/** Yapılandırılmış alım aralığı (15 sn – 5 dk arasına sıkıştırılır). */
export function ingestionIntervalMs(): number {
  const raw = numberFromEnv("PRICE_INGESTION_INTERVAL_MS", DEFAULT_INGESTION_INTERVAL_MS, { min: 1 });
  return Math.min(MAX_INGESTION_INTERVAL_MS, Math.max(MIN_INGESTION_INTERVAL_MS, Math.round(raw)));
}

const ALL_PRODUCT_IDS = GOLD_PRODUCTS.map((product) => product.id);
const KNOWN_PRODUCT_IDS = new Set(ALL_PRODUCT_IDS);

/**
 * GÖZLEM ZAMANI POLİTİKASI OLAN SAĞLAYICILAR
 *
 * Bu tabloda OLMAYAN bir sağlayıcı, zaman damgasının kökenini beyan etmeden
 * fiyat yazamaz. Liste kasten kısadır ve her satırın gerekçesi sağlayıcı
 * dosyasındaki "ZAMAN DAMGASI" notundadır.
 */
const OBSERVED_TIME_POLICIES: Readonly<
  Partial<Record<string, { providerId: ProviderId; maxObservationAgeMs: number }>>
> = {
  "truncgil-turkiye": { providerId: "truncgil-turkiye", maxObservationAgeMs: 30 * 60_000 },
  "anlik-altin-kapalicarsi": { providerId: "anlik-altin-kapalicarsi", maxObservationAgeMs: 45 * 60_000 },
};

export interface IngestionOutcome {
  providerCode: string;
  attempted: boolean;
  result: IngestionResult | null;
  accepted: number;
  quarantined: { canonicalProductId: string; code: QuoteRejectionCode }[];
  safeErrorCode: string | null;
  message: string;
}

export interface IngestionOptions {
  now?: () => number;
  /** Aynı koşumun tekrar uygulanmasını test etmek için sabit anahtar. */
  runKey?: string;
  fetchImpl?: typeof fetch;
}

export class PriceIngestionService {
  /**
   * Arka uç örneği başına tek seferlik katalog eşitlemesi.
   *
   * Katalog yalnızca yönetim sayfası veya cron çalıştığında eşitlenseydi, hiç
   * ziyaret edilmemiş yeni bir kurulumda kullanıcı ekranı boş kalırdı. Bu yüzden
   * fiyat kaynağı okuyan/yazan her giriş noktası önce bunu çağırır. Eşitleme
   * idempotenttir; başarısız olursa önbelleğe alınmaz ve sonraki çağrı yeniden dener.
   * Önbellek arka uca göre (WeakMap) tutulur; her testin kendi arka ucu yeniden eşitlenir.
   */
  private static catalogReady = new WeakMap<AuthBackend, Promise<number>>();

  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Katalogun en az bir kez eşitlendiğini garanti eder (süreç başına bir kez). */
  async ensureCatalog(): Promise<void> {
    const cached = PriceIngestionService.catalogReady.get(this.backend);
    if (cached) {
      await cached;
      return;
    }
    const pending = this.syncCatalog().catch((error: unknown) => {
      // Başarısız eşitleme önbellekte kalmaz; sonraki çağrı yeniden dener.
      PriceIngestionService.catalogReady.delete(this.backend);
      throw error;
    });
    PriceIngestionService.catalogReady.set(this.backend, pending);
    await pending;
  }

  /** Yalnızca test içindir: bu arka ucun önbelleğini sıfırlar. */
  resetCatalogCache(): void {
    PriceIngestionService.catalogReady.delete(this.backend);
  }

  /** Koddaki sağlayıcı tanımlarını ve eşlemeleri veritabanına yansıtır (idempotent). */
  async syncCatalog(): Promise<number> {
    const payload: ProviderSyncInput[] = [];
    for (const descriptor of listProviderDescriptors()) {
      const provider = getProviderInstance(descriptor.providerId);
      if (!provider) continue;
      payload.push({
        code: descriptor.providerId,
        displayName: descriptor.displayName,
        technicalName: descriptor.technicalName,
        marketId: descriptor.marketId,
        marketDisplayName: descriptor.marketDisplayName,
        providerType: descriptor.providerType,
        licenseStatus: provider.licenseStatus(),
        licenseReference: provider.licenseReference(),
        // Yeniden gösterim izni yalnızca lisans LICENSED ise true kabul edilir.
        redistributionAllowed: provider.licenseStatus() === "LICENSED",
        capabilities: descriptor.capabilities,
        attribution: descriptor.attribution,
        referenceUrl: descriptor.referenceUrl,
      });
    }
    const count = await this.backend.syncPriceProviders(payload);
    for (const descriptor of listProviderDescriptors()) {
      const provider = getProviderInstance(descriptor.providerId);
      if (!provider) continue;
      const mapping = Object.fromEntries(
        Object.entries((provider as { mapping?: Record<string, string> }).mapping ?? {}),
      );
      if (Object.keys(mapping).length === 0) continue;
      await this.backend.syncPriceMappings(
        descriptor.providerId,
        (provider as { mappingVersion?: string }).mappingVersion ?? "unknown",
        mapping,
      );
    }

    // ÜRETİM TEMİZLİĞİ: veritabanında geçmişten kalmış açık bir test sağlayıcısı
    // varsa zorla kapatılır. Aksi hâlde staging'de açılmış test verisi, aynı
    // veritabanı üretime taşındığında sessizce kullanıcıya fiyat verirdi.
    if (devOnlyProviderBlocked()) {
      const rows = await this.backend.listPriceProviders();
      for (const row of rows) {
        if (row.licenseStatus !== "DEV_ONLY") continue;
        if (!row.enabled && !row.userSelectable && !row.isDefault) continue;
        await this.backend.setPriceProviderFlags(row.code, false, false).catch(() => {
          // Kapatma başarısız olsa bile test sağlayıcısı çalışma zamanında zaten
          // veri üretmez (fetchSnapshot bloklu); bir sonraki eşitlemede yeniden denenir.
        });
      }
    }
    return count;
  }

  /** Tek bir sağlayıcıdan fiyat çeker, doğrular ve uygular. */
  async ingestProvider(providerCode: string, options: IngestionOptions = {}): Promise<IngestionOutcome> {
    await this.ensureCatalog();
    const provider = getProviderInstance(providerCode);
    if (!provider) {
      return {
        providerCode,
        attempted: false,
        result: null,
        accepted: 0,
        quarantined: [],
        safeErrorCode: "UNKNOWN_PROVIDER",
        message: "Bilinmeyen fiyat sağlayıcısı.",
      };
    }

    const validation = provider.validateConfiguration();
    if (!validation.ok) {
      // Lisanssız / yapılandırılmamış kaynaktan veri ÇEKİLMEZ ve veri varmış gibi davranılmaz.
      return {
        providerCode,
        attempted: false,
        result: null,
        accepted: 0,
        quarantined: [],
        safeErrorCode: validation.licenseStatus === "LICENSE_REQUIRED" ? "LICENSE_REQUIRED" : "NOT_CONFIGURED",
        message:
          validation.licenseStatus === "LICENSE_REQUIRED"
            ? "Lisans veya yeniden gösterim izni bulunmadığı için veri alınmadı."
            : "Sağlayıcı yapılandırılmadığı için veri alınmadı.",
      };
    }

    const now = options.now?.() ?? this.now();
    const runKey = options.runKey ?? `${providerCode}:${randomUUID()}`;
    const snapshot = await provider.fetchSnapshot(ALL_PRODUCT_IDS, {
      now: () => now,
      ingestionRunId: runKey,
      fetchImpl: options.fetchImpl,
    });

    // DEVRE KESİCİ REFERANSI
    //
    // Sıçrama kontrolü ancak önceki KABUL EDİLMİŞ fiyat bilinirse çalışır. Referans
    // yalnızca AYNI sağlayıcının aynı piyasadaki güncel kaydından alınır: başka
    // sağlayıcının veya başka piyasanın fiyatı karşılaştırmaya karışmaz. Karantinaya
    // alınan fiyatlar güncel tabloya hiç yazılmadığı için referans da olamaz.
    // İlk alımda önceki değer yoktur; o durumda PRICE_JUMP uygulanmaz.
    const previous = await this.previousLiquidationMap(providerCode, provider.marketId);
    const quality = evaluateSnapshot(snapshot.quotes, {
      providerId: provider.providerId,
      marketId: provider.marketId,
      knownProductIds: KNOWN_PRODUCT_IDS,
      now,
      previousLiquidation: (productId) => previous.get(productId) ?? null,
      // GÖZLEM ZAMANI POLİTİKASI
      //
      // İki kaynak da kendi güncelleme zamanını yayımlar ama SAAT DİLİMİ
      // yazmaz; +03:00 varsayımı bizimdir. Bu yüzden damga "sağlayıcı zamanı"
      // değil GÖZLEM zamanı sayılır ve bu politika olmadan kalite kapısı
      // fiyatı TIMESTAMP_PROVENANCE_UNKNOWN ile reddeder.
      //
      // Politika SAĞLAYICI BAŞINA açılır; listede olmayan hiçbir kaynak bu
      // yolla zaman damgası kuralını atlayamaz. Yaş sınırları, kaynakların
      // kendi güncelleme sıklığından (birkaç dakika) belirgin biçimde geniştir
      // ama bayat veriyi güncel göstermeyecek kadar dardır.
      observedTimePolicy: OBSERVED_TIME_POLICIES[provider.providerId],
    });

    const payload: IngestionPayload = {
      status: snapshot.status,
      safeErrorCode: snapshot.safeErrorCode,
      latencyMs: snapshot.latencyMs,
      fetchedAt: snapshot.fetchedAt,
      quotes: quality.accepted.map((quote: NormalizedQuote) => ({
        canonicalProductId: quote.canonicalProductId,
        liquidationPrice: quote.liquidationPrice,
        replacementPrice: quote.replacementPrice,
        upstreamSourceId: quote.upstreamSourceId,
        providerTimestamp: quote.providerTimestamp,
        fetchedAt: quote.fetchedAt,
        status: "ok",
        mappingVersion: quote.mappingVersion,
        rawPayloadHash: quote.rawPayloadHash,
      })),
      // Karantina kaydı KALICI hâle gelir: hangi ürün, hangi fiyat, hangi sebep,
      // hangi zaman ve hangi eşleme sürümü. Ham yanıt saklanmaz.
      quarantined: quality.quarantined.map((entry) => ({
        canonicalProductId: entry.quote.canonicalProductId,
        code: entry.code,
        liquidationPrice: entry.quote.liquidationPrice ?? null,
        replacementPrice: entry.quote.replacementPrice ?? null,
        currency: entry.quote.currency ?? null,
        providerTimestamp: entry.quote.providerTimestamp ?? null,
        fetchedAt: entry.quote.fetchedAt ?? null,
        mappingVersion: entry.quote.mappingVersion ?? null,
        rawPayloadHash: entry.quote.rawPayloadHash ?? null,
      })),
    };

    const result = await this.backend.applyPriceIngestion(providerCode, runKey, payload);
    return {
      providerCode,
      attempted: true,
      result,
      accepted: quality.accepted.length,
      quarantined: quality.quarantined.map((entry) => ({
        canonicalProductId: entry.quote.canonicalProductId,
        code: entry.code,
      })),
      safeErrorCode: snapshot.safeErrorCode,
      message:
        result.skipped && result.replayed
          ? "Bu koşum daha önce uygulanmıştı; tekrar yazılmadı."
          : result.skipped
            ? "Aynı sağlayıcı için başka bir alım sürüyor; bu koşum atlandı."
            : `${quality.accepted.length} fiyat güncellendi, ${quality.quarantined.length} kayıt karantinaya alındı.`,
    };
  }

  /**
   * Sağlayıcının güncel (kabul edilmiş) bozdurma fiyatları.
   *
   * Okuma başarısız olursa sıçrama kontrolü sessizce DEVRE DIŞI kalır; alım
   * engellenmez. Referans yokluğu fiyatı reddetme sebebi değildir.
   */
  private async previousLiquidationMap(
    providerCode: string,
    marketId: string,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const row = await this.backend.currentPriceQuotes(providerCode);
      if (!row || row.marketId !== marketId) return map;
      for (const quote of row.quotes) {
        if (quote.status !== "ok") continue;
        const value = Number(quote.liquidationPrice);
        if (Number.isFinite(value) && value > 0) map.set(quote.canonicalProductId, value);
      }
    } catch {
      return new Map();
    }
    return map;
  }

  /**
   * Zamanlanmış alım: yalnızca etkin ve lisanslı sağlayıcılar çekilir.
   * Test verisi sağlayıcısı üretim cron'unda ÇALIŞMAZ.
   */
  async ingestEnabled(options: IngestionOptions = {}): Promise<IngestionOutcome[]> {
    const providers = await this.backend.listPriceProviders();
    const outcomes: IngestionOutcome[] = [];
    for (const provider of providers) {
      if (!provider.enabled) continue;
      if (provider.licenseStatus === "DEV_ONLY" && devOnlyProviderBlocked()) continue;
      if (provider.capabilities.includes("REFERENCE_ONLY")) continue;
      outcomes.push(
        await this.ingestProvider(provider.code, {
          ...options,
          runKey: options.runKey ? `${provider.code}:${options.runKey}` : undefined,
        }),
      );
    }
    return outcomes;
  }
}
