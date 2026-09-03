import type { LicenseStatus, ProviderCapability } from "@/prices/contract";

// NOT: bu modül yalnızca TİP ve hata sınıfı içerir; secret veya sunucu istemcisi
// barındırmaz. "server-only" işareti YOKTUR çünkü Node tarafındaki test/CLI
// araçları (Playwright global setup, admin betikleri) arka uç tiplerini içe aktarır.
// Gerçek sunucu servisleri (ingestion-service, price-source-service) server-only'dir.

/**
 * Fiyat katmanının arka uç sözleşmesi.
 *
 * Bütün fiyat okuma/yazma işlemleri bu metotlardan geçer; Supabase arka ucunda
 * SECURITY DEFINER RPC'lere, yerel geliştirme arka ucunda aynı kuralları
 * uygulayan bellek/dosya deposuna bağlanır.
 */

export interface ProviderHealthRow {
  status: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  coverageCount: number;
  staleCount: number;
  quarantinedCount: number;
  latencyMs: number | null;
  safeErrorCode: string | null;
}

export interface IngestionRunRow {
  status: string;
  startedAt: string;
  completedAt: string | null;
  quoteCount: number;
  rejectedCount: number;
  latencyMs: number | null;
  safeErrorCode: string | null;
}

/** Veritabanındaki sağlayıcı durumu (admin ekranı). */
export interface ProviderStateRow {
  code: string;
  displayName: string;
  technicalName: string;
  marketId: string;
  marketDisplayName: string;
  providerType: string;
  enabled: boolean;
  userSelectable: boolean;
  licenseStatus: LicenseStatus;
  licenseReference: string | null;
  redistributionAllowed: boolean;
  capabilities: ProviderCapability[];
  attribution: string;
  referenceUrl: string | null;
  coverage: number;
  mappingCount: number;
  health: ProviderHealthRow | null;
  lastRun: IngestionRunRow | null;
}

export interface StoredQuoteRow {
  canonicalProductId: string;
  marketId: string;
  liquidationPrice: string;
  replacementPrice: string;
  currency: string;
  upstreamSourceId: string | null;
  providerTimestamp: string;
  fetchedAt: string;
  status: string;
  mappingVersion: string;
}

export interface ProviderQuotesRow {
  providerCode: string;
  marketId: string;
  displayName: string;
  technicalName: string;
  marketDisplayName: string;
  licenseStatus: LicenseStatus;
  enabled: boolean;
  userSelectable: boolean;
  attribution: string;
  health: ProviderHealthRow | null;
  quotes: StoredQuoteRow[];
}

export interface IngestionQuoteInput {
  canonicalProductId: string;
  liquidationPrice: string;
  replacementPrice: string;
  upstreamSourceId: string | null;
  providerTimestamp: string;
  fetchedAt: string;
  status: string;
  mappingVersion: string;
  rawPayloadHash: string | null;
}

export interface IngestionPayload {
  status: "ok" | "partial" | "unavailable";
  safeErrorCode: string | null;
  latencyMs: number | null;
  fetchedAt: string;
  quotes: IngestionQuoteInput[];
  quarantined: { canonicalProductId: string; code: string }[];
}

export interface IngestionResult {
  runId: string;
  status: string;
  skipped: boolean;
  quoteCount: number;
  rejectedCount: number;
  replayed: boolean;
}

export interface PricePreferenceRow {
  portfolioId: string | null;
  providerCode: string | null;
  marketId: string | null;
  selectedAt: string | null;
  selectedBy: string | null;
}

export interface PricePreferenceResult {
  portfolioId: string;
  providerCode: string;
  marketId: string;
  previousProviderCode: string | null;
  changed: boolean;
}

export interface PriceSourceEventRow {
  changedAt: string;
  previousProviderCode: string | null;
  newProviderCode: string | null;
  previousMarketId: string | null;
  newMarketId: string | null;
  changedByRole: "user" | "admin";
  reason: string;
}

export interface ProviderSyncInput {
  code: string;
  displayName: string;
  technicalName: string;
  marketId: string;
  marketDisplayName: string;
  providerType: string;
  licenseStatus: LicenseStatus;
  licenseReference: string | null;
  redistributionAllowed: boolean;
  capabilities: readonly ProviderCapability[];
  attribution: string;
  referenceUrl: string | null;
}

/** Sağlayıcı lisanslı/etkin olmadığında atılan hata (HTTP 409'a çevrilir). */
export class ProviderNotSelectableError extends Error {
  constructor(readonly providerCode: string, message: string) {
    super(message);
    this.name = "ProviderNotSelectableError";
  }
}
