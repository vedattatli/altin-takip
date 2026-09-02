import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import type { PortfolioRepository, RepositoryKind } from "./types";

/**
 * Oturum açmış kullanıcının deposu.
 *
 * Veriler sunucudaki hesaba yazılır; aynı hesapla girilen her cihazda
 * aynı portföy görünür. İstemci hiçbir zaman doğrudan veritabanına
 * bağlanmaz; yalnızca oturum çerezi ile korunan API uçlarını çağırır.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "İstek başarısız oldu. Lütfen tekrar deneyin.");
  }
  return (payload?.data ?? null) as T;
}

export class ServerPortfolioRepository implements PortfolioRepository {
  readonly kind: RepositoryKind = "server";
  readonly label = "Hesabınız";
  readonly syncsAcrossDevices = true;

  async getPortfolio(): Promise<PortfolioMeta> {
    return request<PortfolioMeta>("/api/portfolio");
  }

  async renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta> {
    return request<PortfolioMeta>("/api/portfolio", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async listTransactions(): Promise<Transaction[]> {
    return request<Transaction[]>("/api/transactions");
  }

  async createTransaction(input: TransactionInput): Promise<Transaction> {
    return request<Transaction>("/api/transactions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateTransaction(id: string, input: TransactionInput): Promise<Transaction> {
    return request<Transaction>(`/api/transactions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteTransaction(id: string): Promise<void> {
    await request<null>(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async clearTransactions(): Promise<void> {
    await request<null>("/api/transactions", { method: "DELETE" });
  }
}
