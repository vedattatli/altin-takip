import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";

/**
 * Portföy deposu sözleşmesi.
 *
 * Arayüz katmanı YALNIZCA bu sözleşmeyi bilir. Böylece depolama
 * (IndexedDB / sunucu / Supabase) tek noktadan değiştirilebilir.
 */
export type RepositoryKind = "indexeddb" | "memory" | "server";

export interface PortfolioRepository {
  readonly kind: RepositoryKind;
  /** Kullanıcıya gösterilecek depolama etiketi. Örn. "Bu cihaz", "Hesabınız". */
  readonly label: string;
  /** Veriler cihazlar arasında senkronize oluyor mu? */
  readonly syncsAcrossDevices: boolean;

  getPortfolio(): Promise<PortfolioMeta>;
  renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta>;

  listTransactions(): Promise<Transaction[]>;
  createTransaction(input: TransactionInput): Promise<Transaction>;
  updateTransaction(id: string, input: TransactionInput): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  /** Tüm işlemleri siler. Portföy kaydı korunur. */
  clearTransactions(): Promise<void>;
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
