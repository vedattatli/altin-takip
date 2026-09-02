import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import { apiFetch } from "@/lib/api-client";
import type { PortfolioRepository, RepositoryKind } from "./types";

/**
 * Oturum açmış kullanıcının deposu.
 *
 * Veriler sunucudaki hesaba yazılır; aynı hesapla girilen her cihazda
 * aynı portföy görünür. İstemci hiçbir zaman doğrudan veritabanına
 * bağlanmaz; yalnızca oturum çerezi ile korunan API uçlarını çağırır.
 */

export class ServerPortfolioRepository implements PortfolioRepository {
  readonly kind: RepositoryKind = "server";
  readonly label = "Hesabınız";
  readonly syncsAcrossDevices = true;

  async getPortfolio(): Promise<PortfolioMeta> {
    return apiFetch<PortfolioMeta>("/api/portfolio");
  }

  async renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta> {
    return apiFetch<PortfolioMeta>("/api/portfolio", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async listTransactions(): Promise<Transaction[]> {
    return apiFetch<Transaction[]>("/api/transactions");
  }

  async createTransaction(input: TransactionInput): Promise<Transaction> {
    return apiFetch<Transaction>("/api/transactions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateTransaction(id: string, input: TransactionInput): Promise<Transaction> {
    return apiFetch<Transaction>(`/api/transactions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteTransaction(id: string): Promise<void> {
    await apiFetch<null>(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async clearTransactions(): Promise<void> {
    await apiFetch<null>("/api/transactions", { method: "DELETE" });
  }
}
