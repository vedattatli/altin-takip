import { createHash } from "node:crypto";

import {
  type CanonicalPriceProvider,
  type FetchOptions,
  type LicenseStatus,
  type MarketId,
  type NormalizeContext,
  type NormalizedQuote,
  type ProviderCapabilities,
  type ProviderConfigIssue,
  type ProviderConfigValidation,
  type ProviderDescriptor,
  type ProviderHealth,
  type ProviderId,
  type ProviderSnapshot,
  type ProviderType,
} from "../contract";

/**
 * Sağlayıcı adapter'ları için ortak temel.
 *
 * - Ortam değişkenleri yalnızca ADLARIYLA raporlanır; DEĞER hiçbir yere yazılmaz.
 * - Yeniden gösterim izni açıkça "true" değilse lisans LICENSED olamaz (fail closed).
 * - Ağ hataları kullanıcıya güvenli kod ve Türkçe mesajla döner; ham yanıt saklanmaz.
 */

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

export function readEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function isFlagTrue(name: string): boolean {
  return readEnv(name).toLowerCase() === "true";
}

/** Ham yanıtın kısa özeti (denetim izi). Ham yanıtın kendisi saklanmaz. */
export function hashPayload(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Saniye veya milisaniye epoch.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Sağlayıcı sayısını kanonik ondalık dizeye çevirir; geçersizse null. */
export function decimalOrNull(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return String(Math.round(value * 1e8) / 1e8);
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s/g, "");
  if (text === "") return null;
  // "1.234,56" (TR gruplu) ve "1234.56" biçimleri kabul edilir; bilimsel gösterim reddedilir.
  let normalized = text;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) normalized = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d+$/.test(text)) normalized = text.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return normalized.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export interface BaseProviderOptions {
  descriptor: ProviderDescriptor;
  /** Sembol → kanonik ürün eşlemesi. */
  mapping: Readonly<Record<string, string>>;
  mappingVersion: string;
  staleAfterMs?: number;
}

export abstract class BaseProvider implements CanonicalPriceProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly technicalName: string;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly providerType: ProviderType;
  readonly descriptor: ProviderDescriptor;
  readonly mapping: Readonly<Record<string, string>>;
  readonly mappingVersion: string;
  readonly staleAfterMs: number;

  constructor(options: BaseProviderOptions) {
    this.descriptor = options.descriptor;
    this.providerId = options.descriptor.providerId;
    this.displayName = options.descriptor.displayName;
    this.technicalName = options.descriptor.technicalName;
    this.marketId = options.descriptor.marketId;
    this.marketDisplayName = options.descriptor.marketDisplayName;
    this.providerType = options.descriptor.providerType;
    this.mapping = options.mapping;
    this.mappingVersion = options.mappingVersion;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  getCapabilities(): ProviderCapabilities {
    const capabilities = this.descriptor.capabilities;
    return {
      capabilities,
      canBePrimary: !capabilities.includes("REFERENCE_ONLY"),
      supportsWebSocket: capabilities.includes("WEBSOCKET"),
      // WebSocket kalıcı bağlantı gerektirir; istek ömrü içinde açılmaz.
      requiresPersistentWorker: capabilities.includes("WEBSOCKET"),
    };
  }

  listSupportedProducts(): readonly string[] {
    return [...new Set(Object.values(this.mapping))];
  }

  licenseReference(): string | null {
    return null;
  }

  abstract licenseStatus(): LicenseStatus;
  abstract validateConfiguration(): ProviderConfigValidation;
  abstract fetchSnapshot(productIds: readonly string[], options?: FetchOptions): Promise<ProviderSnapshot>;
  abstract normalizeQuote(raw: unknown, context: NormalizeContext): NormalizedQuote | null;

  async healthCheck(options: FetchOptions = {}): Promise<ProviderHealth> {
    const now = options.now?.() ?? Date.now();
    const checkedAt = new Date(now).toISOString();
    const validation = this.validateConfiguration();
    if (!validation.ok) {
      const licenseRequired = validation.licenseStatus === "LICENSE_REQUIRED";
      return {
        providerId: this.providerId,
        status: licenseRequired ? "license_required" : "not_configured",
        checkedAt,
        latencyMs: null,
        message: licenseRequired
          ? "Lisans veya yeniden gösterim izni bulunmadığı için kaynak kullanılamıyor."
          : "Sağlayıcı yapılandırılmadı; gerekli ortam değişkenleri eksik.",
        safeErrorCode: licenseRequired ? "LICENSE_REQUIRED" : "NOT_CONFIGURED",
      };
    }
    const started = Date.now();
    const snapshot = await this.fetchSnapshot(this.listSupportedProducts().slice(0, 3), options);
    return {
      providerId: this.providerId,
      status: snapshot.status === "unavailable" ? "unavailable" : snapshot.status === "partial" ? "degraded" : "ok",
      checkedAt,
      latencyMs: Date.now() - started,
      message:
        snapshot.status === "ok"
          ? "Bağlantı başarılı."
          : (snapshot.error ?? "Sağlayıcıdan tam veri alınamadı."),
      safeErrorCode: snapshot.safeErrorCode,
    };
  }

  /** Yapılandırılmamış / lisanssız sağlayıcılar için standart boş snapshot. */
  protected unavailableSnapshot(
    message: string,
    safeErrorCode: string,
    options: FetchOptions = {},
    latencyMs = 0,
  ): ProviderSnapshot {
    const now = options.now?.() ?? Date.now();
    return {
      providerId: this.providerId,
      marketId: this.marketId,
      quotes: [],
      fetchedAt: new Date(now).toISOString(),
      status: "unavailable",
      error: message,
      safeErrorCode,
      latencyMs,
    };
  }

  /** Eksik ortam değişkeni ADLARINI çıkarır. */
  protected missingEnv(names: readonly string[]): ProviderConfigIssue[] {
    return names
      .filter((name) => readEnv(name) === "")
      .map((name) => ({ variable: name, message: `${name} tanımlı değil.` }));
  }

  /** Zaman aşımlı, secret sızdırmayan HTTP çağrısı. */
  protected async httpJson(
    url: string,
    init: RequestInit,
    options: FetchOptions,
  ): Promise<{ ok: true; data: unknown; raw: string } | { ok: false; code: string; message: string }> {
    const impl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await impl(url, {
        ...init,
        signal: options.signal ?? controller.signal,
        cache: "no-store",
      });
      const raw = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          code: `HTTP_${response.status}`,
          message:
            response.status === 401 || response.status === 403
              ? "Fiyat sağlayıcısı erişimi reddetti (kimlik doğrulama veya lisans)."
              : "Fiyat sağlayıcısına ulaşılamadı.",
        };
      }
      try {
        return { ok: true, data: JSON.parse(raw), raw };
      } catch {
        return { ok: false, code: "INVALID_JSON", message: "Fiyat sağlayıcısı beklenen biçimde yanıt vermedi." };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "TIMEOUT" : "NETWORK",
        message: aborted
          ? "Fiyat sağlayıcısı zamanında yanıt vermedi."
          : "Fiyat sağlayıcısına bağlanılamadı.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Yalnızca metadata taşıyan, veri ÇEKMEYEN adapter.
 * Resmî API sözleşmesi ve yazılı izin gelene kadar bu sınıf kullanılır:
 * hiçbir koşulda gerçek veri ürettiği iddia edilmez ve site scrape edilmez.
 */
export class DisabledProvider extends BaseProvider {
  constructor(descriptor: ProviderDescriptor, private readonly reason: LicenseStatus = "LICENSE_REQUIRED") {
    super({ descriptor, mapping: {}, mappingVersion: "none" });
  }

  licenseStatus(): LicenseStatus {
    return this.reason;
  }

  validateConfiguration(): ProviderConfigValidation {
    return {
      ok: false,
      licenseStatus: this.reason,
      issues: [
        {
          variable: "—",
          message:
            this.reason === "LICENSE_REQUIRED"
              ? "Resmî API sözleşmesi ve yazılı yeniden gösterim izni bekleniyor. Sayfa içeriği scrape edilmez."
              : "Sağlayıcı yapılandırılmadı.",
        },
      ],
    };
  }

  async fetchSnapshot(_productIds: readonly string[], options: FetchOptions = {}): Promise<ProviderSnapshot> {
    return this.unavailableSnapshot(
      "Bu kaynak için resmî API sözleşmesi ve lisans bulunmadığından veri alınmıyor.",
      this.reason === "LICENSE_REQUIRED" ? "LICENSE_REQUIRED" : "NOT_CONFIGURED",
      options,
    );
  }

  normalizeQuote(): NormalizedQuote | null {
    return null;
  }
}
