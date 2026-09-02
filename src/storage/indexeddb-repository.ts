import type {
  AccountingSummary,
  LedgerAppendResult,
  LedgerCommand,
  LedgerEntry,
  LedgerReplaceResult,
  LedgerVoidResult,
} from "@/domain/accounting/types";
import type { PortfolioMeta } from "@/domain/types";
import {
  localAppend,
  localReplace,
  localSnapshot,
  localSummary,
  localVoid,
  localVoidAll,
  sortLedgerDesc,
  type LocalLedgerState,
} from "./local-ledger";
import { defaultPortfolio, nowISO, type PortfolioRepository, type RepositoryKind } from "./types";

/**
 * Demo modu deposu — IndexedDB.
 *
 * Veriler YALNIZCA bu tarayıcıda, bu cihazda saklanır. Sunucuya gitmez,
 * cihazlar arasında senkronize olmaz. Sayfa yenilense de korunur.
 * Kayıtlar defter (ledger) olarak tutulur; eski "transactions" deposu
 * yok sayılır (demo verisi taşınmaz).
 */

const DB_NAME = "altin-takip";
const DB_VERSION = 2;
const STORE_PORTFOLIO = "portfolio";
const STORE_LEDGER = "ledger";
const PORTFOLIO_KEY = "current";

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB isteği başarısız oldu."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB işlemi iptal edildi."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB işlemi başarısız oldu."));
  });
}

export function openDatabase(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PORTFOLIO)) {
        db.createObjectStore(STORE_PORTFOLIO);
      }
      if (!db.objectStoreNames.contains(STORE_LEDGER)) {
        const store = db.createObjectStore(STORE_LEDGER, { keyPath: "id" });
        store.createIndex("occurredAt", "occurredAt", { unique: false });
        store.createIndex("productId", "productId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB açılamadı."));
  });
}

export class IndexedDbPortfolioRepository implements PortfolioRepository {
  readonly kind: RepositoryKind = "indexeddb";
  readonly label = "Yalnızca bu cihaz";
  readonly syncsAcrossDevices = false;

  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName: string = DB_NAME) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDatabase(this.dbName);
    return this.dbPromise;
  }

  async getPortfolio(): Promise<PortfolioMeta> {
    const db = await this.db();
    const tx = db.transaction(STORE_PORTFOLIO, "readonly");
    const existing = await promisify<PortfolioMeta | undefined>(
      tx.objectStore(STORE_PORTFOLIO).get(PORTFOLIO_KEY),
    );
    await transactionDone(tx);
    if (existing) return existing;

    // Yeni portföy HER ZAMAN boş başlar; örnek varlık eklenmez.
    const created = defaultPortfolio();
    await this.writePortfolio(created);
    return created;
  }

  private async writePortfolio(portfolio: PortfolioMeta): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_PORTFOLIO, "readwrite");
    tx.objectStore(STORE_PORTFOLIO).put(portfolio, PORTFOLIO_KEY);
    await transactionDone(tx);
  }

  async renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta> {
    const current = await this.getPortfolio();
    const updated: PortfolioMeta = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      updatedAt: nowISO(),
    };
    await this.writePortfolio(updated);
    return updated;
  }

  private async readState(): Promise<LocalLedgerState> {
    const db = await this.db();
    const tx = db.transaction(STORE_LEDGER, "readonly");
    const entries = await promisify<LedgerEntry[]>(tx.objectStore(STORE_LEDGER).getAll());
    await transactionDone(tx);
    return {
      entries,
      nextSequence: entries.reduce((max, entry) => Math.max(max, entry.ledgerSequence), 0) + 1,
    };
  }

  private async writeEntries(entries: readonly LedgerEntry[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_LEDGER, "readwrite");
    const store = tx.objectStore(STORE_LEDGER);
    for (const entry of entries) store.put(entry);
    await transactionDone(tx);
  }

  async getSummary(): Promise<AccountingSummary> {
    const state = await this.readState();
    return localSummary(state.entries, await localSnapshot());
  }

  async listLedger(): Promise<LedgerEntry[]> {
    return sortLedgerDesc((await this.readState()).entries);
  }

  async appendTransaction(command: LedgerCommand): Promise<LedgerAppendResult> {
    const portfolio = await this.getPortfolio();
    const state = await this.readState();
    const { result, entries } = await localAppend(state, portfolio.id, command);
    if (!result.replayed) await this.writeEntries(entries.filter((entry) => entry.id === result.entry.id));
    return result;
  }

  async replaceTransaction(id: string, command: LedgerCommand): Promise<LedgerReplaceResult> {
    const portfolio = await this.getPortfolio();
    const state = await this.readState();
    const { result, entries } = await localReplace(state, portfolio.id, id, command);
    await this.writeEntries(entries.filter((entry) => entry.id === id || entry.id === result.entry.id));
    return result;
  }

  async voidTransaction(id: string, reason: string): Promise<LedgerVoidResult> {
    const state = await this.readState();
    const { result, entries } = localVoid(state, id, reason);
    await this.writeEntries(entries.filter((entry) => entry.id === id));
    return result;
  }

  async voidAll(): Promise<number> {
    const state = await this.readState();
    const { count, entries } = localVoidAll(state);
    await this.writeEntries(entries);
    return count;
  }
}
