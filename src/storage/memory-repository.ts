import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import {
  createId,
  defaultPortfolio,
  nowISO,
  type PortfolioRepository,
  type RepositoryKind,
} from "./types";

/**
 * Bellek içi depo. Testler ve sunucu tarafı yardımcıları için.
 * Sayfa yenilenince veriyi KORUMAZ; üretimde kullanılmaz.
 */
export class MemoryPortfolioRepository implements PortfolioRepository {
  readonly kind: RepositoryKind = "memory";
  readonly label = "Geçici bellek";
  readonly syncsAcrossDevices = false;

  private portfolio: PortfolioMeta;
  private transactions: Transaction[] = [];

  constructor(portfolio: PortfolioMeta = defaultPortfolio()) {
    this.portfolio = portfolio;
  }

  async getPortfolio(): Promise<PortfolioMeta> {
    return { ...this.portfolio };
  }

  async renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta> {
    this.portfolio = {
      ...this.portfolio,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      updatedAt: nowISO(),
    };
    return { ...this.portfolio };
  }

  async listTransactions(): Promise<Transaction[]> {
    return this.transactions.map((tx) => ({ ...tx }));
  }

  async createTransaction(input: TransactionInput): Promise<Transaction> {
    const timestamp = nowISO();
    const transaction: Transaction = {
      ...input,
      id: createId(),
      portfolioId: this.portfolio.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.transactions.push(transaction);
    return { ...transaction };
  }

  async updateTransaction(id: string, input: TransactionInput): Promise<Transaction> {
    const index = this.transactions.findIndex((tx) => tx.id === id);
    if (index === -1) throw new Error("İşlem bulunamadı.");
    const updated: Transaction = {
      ...this.transactions[index],
      ...input,
      updatedAt: nowISO(),
    };
    this.transactions[index] = updated;
    return { ...updated };
  }

  async deleteTransaction(id: string): Promise<void> {
    this.transactions = this.transactions.filter((tx) => tx.id !== id);
  }

  async clearTransactions(): Promise<void> {
    this.transactions = [];
  }
}
