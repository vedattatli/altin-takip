import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import {
  createId,
  defaultPortfolio,
  nowISO,
  type PortfolioRepository,
  type RepositoryKind,
} from "./types";

/**
 * Demo modu deposu — IndexedDB.
 *
 * Veriler YALNIZCA bu tarayıcıda, bu cihazda saklanır. Sunucuya gitmez,
 * cihazlar arasında senkronize olmaz. Sayfa yenilense de korunur.
 */

const DB_NAME = "altin-takip";
const DB_VERSION = 1;
const STORE_PORTFOLIO = "portfolio";
const STORE_TRANSACTIONS = "transactions";
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
      if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const store = db.createObjectStore(STORE_TRANSACTIONS, { keyPath: "id" });
        store.createIndex("tradedAt", "tradedAt", { unique: false });
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

  async listTransactions(): Promise<Transaction[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_TRANSACTIONS, "readonly");
    const rows = await promisify<Transaction[]>(tx.objectStore(STORE_TRANSACTIONS).getAll());
    await transactionDone(tx);
    return rows;
  }

  async createTransaction(input: TransactionInput): Promise<Transaction> {
    const portfolio = await this.getPortfolio();
    const timestamp = nowISO();
    const transaction: Transaction = {
      ...input,
      id: createId(),
      portfolioId: portfolio.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const db = await this.db();
    const tx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    tx.objectStore(STORE_TRANSACTIONS).add(transaction);
    await transactionDone(tx);
    return transaction;
  }

  async updateTransaction(id: string, input: TransactionInput): Promise<Transaction> {
    const db = await this.db();
    const readTx = db.transaction(STORE_TRANSACTIONS, "readonly");
    const existing = await promisify<Transaction | undefined>(
      readTx.objectStore(STORE_TRANSACTIONS).get(id),
    );
    await transactionDone(readTx);
    if (!existing) throw new Error("İşlem bulunamadı.");

    const updated: Transaction = { ...existing, ...input, updatedAt: nowISO() };
    const writeTx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    writeTx.objectStore(STORE_TRANSACTIONS).put(updated);
    await transactionDone(writeTx);
    return updated;
  }

  async deleteTransaction(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    tx.objectStore(STORE_TRANSACTIONS).delete(id);
    await transactionDone(tx);
  }

  async clearTransactions(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_TRANSACTIONS, "readwrite");
    tx.objectStore(STORE_TRANSACTIONS).clear();
    await transactionDone(tx);
  }
}
