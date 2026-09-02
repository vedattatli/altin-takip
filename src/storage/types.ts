import type {
  AccountingSummary,
  LedgerAppendResult,
  LedgerCommand,
  LedgerEntry,
  LedgerReplaceResult,
  LedgerVoidResult,
} from "@/domain/accounting/types";
import type { PortfolioMeta } from "@/domain/types";

/**
 * Portföy deposu sözleşmesi.
 *
 * Arayüz katmanı YALNIZCA bu sözleşmeyi bilir. Böylece depolama
 * (IndexedDB demo / sunucu) tek noktadan değiştirilebilir.
 *
 * Kaynak gerçek işlem defteridir; özet (pozisyon + değerleme) türetilir.
 * Sunucu deposunda özet SUNUCUDA hesaplanır; demo depolarında aynı motor
 * istemcide çalışır.
 */
export type RepositoryKind = "indexeddb" | "memory" | "server";

/** Defter sürümü sorgusu sonucu (yalnızca sunucu deposu). */
export type PortfolioVersionResult =
  | { notModified: true }
  | { notModified: false; revision: number; updatedAt: string; etag: string | null };

export interface PortfolioRepository {
  readonly kind: RepositoryKind;
  /** Kullanıcıya gösterilecek depolama etiketi. Örn. "Bu cihaz", "Hesabınız". */
  readonly label: string;
  /** Veriler cihazlar arasında senkronize oluyor mu? */
  readonly syncsAcrossDevices: boolean;

  getPortfolio(): Promise<PortfolioMeta>;
  renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta>;

  /** Pozisyonlar + güncel (test) fiyatla değerleme. Salt okuma. */
  getSummary(): Promise<AccountingSummary>;
  /** Bütün defter kayıtları (ACTIVE, VOID, REPLACED). */
  listLedger(): Promise<LedgerEntry[]>;
  /** OPENING_BALANCE / BUY / SELL ekler (idempotent: command.clientRequestId). */
  appendTransaction(command: LedgerCommand): Promise<LedgerAppendResult>;
  /** Kaydı düzeltir: eski REPLACED, yeni kayıt eklenir. */
  replaceTransaction(id: string, command: LedgerCommand): Promise<LedgerReplaceResult>;
  /** Kaydı iptal eder (VOID). Hard delete yoktur. */
  voidTransaction(id: string, reason: string): Promise<LedgerVoidResult>;
  /** Tüm aktif kayıtları iptal eder. Portföy kaydı korunur. */
  voidAll(): Promise<number>;
  /**
   * Defter sürümü (cihazlar arası senkronizasyon sinyali). Yalnızca sunucu deposunda
   * bulunur; demo depoları tek cihazdadır.
   */
  getVersion?(etag: string | null, signal?: AbortSignal): Promise<PortfolioVersionResult>;
}

export function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function defaultPortfolio(id: string = createId()): PortfolioMeta {
  const timestamp = nowISO();
  return {
    id,
    name: "Portföyüm",
    displayName: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
