import type {
  AccountingSummary,
  LedgerAppendResult,
  LedgerCommand,
  LedgerEntry,
  LedgerReplaceResult,
  LedgerVoidResult,
} from "@/domain/accounting/types";
import type { PortfolioMeta } from "@/domain/types";
import { apiFetch } from "@/lib/api-client";
import type { PortfolioRepository, RepositoryKind } from "./types";

/**
 * Oturum açmış kullanıcının deposu.
 *
 * Veriler sunucudaki hesaba yazılır; aynı hesapla girilen her cihazda
 * aynı portföy görünür. İstemci hiçbir zaman doğrudan veritabanına
 * bağlanmaz; yalnızca oturum çerezi ile korunan API uçlarını çağırır.
 * Özet (pozisyon + değerleme) SUNUCUDA hesaplanır; sayılar ondalık dizedir.
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

  async getSummary(): Promise<AccountingSummary> {
    return apiFetch<AccountingSummary>("/api/portfolio/summary");
  }

  async listLedger(): Promise<LedgerEntry[]> {
    return apiFetch<LedgerEntry[]>("/api/transactions");
  }

  async appendTransaction(command: LedgerCommand): Promise<LedgerAppendResult> {
    return apiFetch<LedgerAppendResult>("/api/transactions", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }

  async replaceTransaction(id: string, command: LedgerCommand): Promise<LedgerReplaceResult> {
    return apiFetch<LedgerReplaceResult>(`/api/transactions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(command),
    });
  }

  async voidTransaction(id: string, reason: string): Promise<LedgerVoidResult> {
    return apiFetch<LedgerVoidResult>(`/api/transactions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    });
  }

  async voidAll(): Promise<number> {
    const result = await apiFetch<{ voided: number }>("/api/transactions", { method: "DELETE" });
    return result?.voided ?? 0;
  }
}
