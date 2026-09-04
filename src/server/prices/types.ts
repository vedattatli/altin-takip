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
  /** Tercihi olmayan kullanıcılar için açık global varsayılan. */
  isDefault: boolean;
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

/**
 * FİYAT GEÇMİŞİ SATIRI — grafik için.
 *
 * `observedAt` fiyatın UYGULAMA TARAFINDAN GÖRÜLDÜĞÜ andır (`fetched_at`).
 * Ekran kaynağının kendi fiyat saati yoktur; bu yüzden grafiğin x ekseni
 * "gözlem zamanı"dır ve arayüzde de öyle adlandırılır.
 */
export interface PriceHistoryRow {
  providerCode: string;
  marketId: string;
  canonicalProductId: string;
  liquidationPrice: string;
  replacementPrice: string;
  currency: string;
  observedAt: string;
  providerTimestamp: string | null;
  status: string;
}

export interface IngestionQuoteInput {
  canonicalProductId: string;
  liquidationPrice: string;
  replacementPrice: string;
  upstreamSourceId: string | null;
  /** Sağlayıcı zamanı; null ise kayıt kalite kapısından geçemez. */
  providerTimestamp: string | null;
  fetchedAt: string;
  status: string;
  mappingVersion: string;
  rawPayloadHash: string | null;
}

/**
 * Karantinaya alınan tek kayıt.
 *
 * Ham yanıt SAKLANMAZ; yalnızca özeti (`rawPayloadHash`) taşınır. Adres, anahtar
 * veya kişisel veri bu yapıya girmez.
 */
export interface IngestionQuarantineInput {
  canonicalProductId: string;
  code: string;
  liquidationPrice: string | null;
  replacementPrice: string | null;
  currency: string | null;
  providerTimestamp: string | null;
  fetchedAt: string | null;
  mappingVersion: string | null;
  rawPayloadHash: string | null;
}

export interface IngestionPayload {
  status: "ok" | "partial" | "unavailable";
  safeErrorCode: string | null;
  latencyMs: number | null;
  fetchedAt: string;
  quotes: IngestionQuoteInput[];
  quarantined: IngestionQuarantineInput[];
}

/** Yönetici tarafından onaylanmış ekran eşlemesi. */
export interface MappingApprovalRow {
  rawLabel: string;
  canonicalProductId: string;
  confidence: string;
  mappingVersion: string;
  evidenceLiquidation: string | null;
  evidenceReplacement: string | null;
  evidenceObservedAt: string | null;
  approvedBy: string | null;
  approvedAt: string;
}

/** Kalıcı tarayıcı worker'ının kira durumu. */
export interface WorkerLeaseState {
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  active: boolean;
}

/** Worker'ın gönderdiği tek ekran gözlemi. */
export interface ScreenObservationInput {
  canonicalProductId: string;
  rawLabel: string;
  mappingConfidence: string;
  liquidationPrice: string;
  replacementPrice: string;
  observedAt: string;
}

/** Worker gönderisinin gövdesi (ham payload veya secret İÇERMEZ). */
export interface ScreenWorkerPayload {
  workerId: string;
  workerVersion: string;
  browserVersion: string;
  mappingVersion: string;
  screenSignature: string;
  headers: string[];
  observedAt: string;
  captchaSeen: boolean;
  observations: ScreenObservationInput[];
  /**
   * Çözülemeyen satırlar. `observedValues` yalnız GÖSTERİM içindir; yön
   * kanıtlanmadığı için değerleme yapılmaz.
   */
  unresolved: { rawProductName: string; reason: string; observedValues?: string[] }[];
  restartCount: number;
}

/** Yönetim ekranındaki karantina satırı (salt okunur). */
export interface QuarantineRow {
  providerCode: string;
  marketId: string;
  canonicalProductId: string;
  rejectionCode: string;
  liquidationPrice: string | null;
  replacementPrice: string | null;
  currency: string | null;
  providerTimestamp: string | null;
  fetchedAt: string | null;
  mappingVersion: string | null;
  createdAt: string;
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

/**
 * EKRANDA GÖRÜNEN TEK HAM SATIR
 *
 * "Kayseri Fiyatları" ekranı Sarraf TV'deki BÜTÜN satırları ham adıyla gösterir.
 * Bir satırın görünmesi, o fiyatın portföy değerlemesine girdiği anlamına
 * GELMEZ — ikisi ayrı kavramdır ve `usedInValuation` bunu açıkça söyler.
 */
export interface ScreenRawRow {
  /** Ekranda YAZDIĞI gibi ham etiket. Çevrilmez, düzeltilmez. */
  rawLabel: string;
  /**
   * Fiyatlar ONDALIK METİN olarak taşınır. Kayan noktaya çevrilmez: para
   * değerlerinde 0,1 gibi sayılar ikili tabanda tam gösterilemez ve
   * yuvarlama hatası birikir.
   */
  /** İki yönlü satırlarda alış (bozdurma); tek fiyatlı satırlarda null. */
  buy: string | null;
  /** İki yönlü satırlarda satış (yeniden alma); tek fiyatlı satırlarda null. */
  sell: string | null;
  /**
   * Tek yönlü referans fiyat. Yön KANITLANMADIĞI için alış/satış alanlarına
   * yazılmaz; aynı rakamı iki yöne birden koymak yanlış olurdu.
   */
  single: string | null;
  canonicalProductId: string | null;
  confidence: string | null;
  /** Portföy değerlemesine giriyor mu? */
  usedInValuation: boolean;
  /** Değerlemeye girmiyorsa sebebi. */
  reason: string | null;
  /**
   * Yön atfedilemeyen ama ekranda görünen birden fazla rakam. Hiçbiri alış
   * veya satış diye etiketlenmez; kaynak bu ayrımı yayımlamıyor.
   */
  observedValues?: string[] | null;
}

/** Saklanan son ham satır kümesi. */
export interface ScreenRowsSnapshot {
  rows: ScreenRawRow[];
  screenSignature: string;
  observedAt: string;
  updatedAt: string;
}
