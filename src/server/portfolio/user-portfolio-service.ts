import "server-only";

import { getProduct } from "@/domain/catalog";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import { validateTransaction } from "@/domain/validation";
import { ownScope, type UserActor } from "@/server/auth/actor";
import { OversellError, type AuthBackend } from "@/server/auth/backend";
import { badRequest, notFound } from "@/server/auth/errors";

/**
 * Kullanıcının KENDİ portföyü.
 *
 * Bu servisin hiçbir metodu hedef kullanıcı kimliği ALMAZ. Erişilen satırlar
 * her zaman `ownScope(actor)` ile belirlenir; dolayısıyla bir route gövdeden
 * gelen bir kimlikle başka kullanıcının verisine ulaşamaz.
 *
 * Başka kullanıcıyı hedefleyen işlemler AdminService'tedir.
 */
export class UserPortfolioService {
  constructor(private readonly backend: AuthBackend) {}

  async getPortfolio(actor: UserActor): Promise<PortfolioMeta> {
    return this.backend.getPortfolio(ownScope(actor));
  }

  async renamePortfolio(
    actor: UserActor,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    const clean = {
      ...(typeof patch.name === "string" ? { name: patch.name.trim().slice(0, 80) } : {}),
      ...(typeof patch.displayName === "string"
        ? { displayName: patch.displayName.trim().slice(0, 80) }
        : {}),
    };
    if (clean.name !== undefined && clean.name.length === 0) {
      throw badRequest("Portföy adı boş olamaz.");
    }
    return this.backend.updatePortfolio(ownScope(actor), clean);
  }

  async listTransactions(actor: UserActor): Promise<Transaction[]> {
    return this.backend.listTransactions(ownScope(actor));
  }

  /**
   * İstemciden gelen gövdeyi SUNUCUDA yeniden doğrular.
   * İstemci doğrulaması yalnızca kullanıcı deneyimi içindir.
   */
  private async parseInput(
    actor: UserActor,
    raw: unknown,
    options: { editingTransactionId?: string } = {},
  ): Promise<TransactionInput> {
    if (typeof raw !== "object" || raw === null) {
      throw badRequest("Geçersiz işlem verisi.");
    }
    const body = raw as Record<string, unknown>;
    const productId = String(body.productId ?? "");
    const product = getProduct(productId);

    const input: TransactionInput = {
      productId,
      side: body.side === "sell" ? "sell" : "buy",
      quantity: Number(body.quantity),
      // Birim istemciden DEĞİL, katalogdan alınır.
      unit: product?.unit ?? "gram",
      tradedAt: String(body.tradedAt ?? ""),
      unitPrice: Number(body.unitPrice),
      feeAmount: Number(body.feeAmount ?? 0),
      note: String(body.note ?? "").slice(0, 280),
    };

    const existing = await this.backend.listTransactions(ownScope(actor));
    const result = validateTransaction(input, {
      existingTransactions: existing,
      editingTransactionId: options.editingTransactionId,
    });

    if (!result.ok) {
      const firstError = Object.values(result.errors).find(Boolean);
      throw badRequest(firstError ?? "İşlem verisi geçersiz.");
    }
    return input;
  }

  /** Aşırı satış kontrolü arka uçta ATOMİK yapılır; buradaki kontrol ön eleme sağlar. */
  private toAppError(error: unknown): never {
    if (error instanceof OversellError) {
      throw badRequest("Satış miktarı elinizdeki miktarı aşamaz.");
    }
    if (error instanceof Error && /İşlem bulunamadı/.test(error.message)) {
      throw notFound("İşlem bulunamadı.");
    }
    throw error;
  }

  async createTransaction(actor: UserActor, raw: unknown): Promise<Transaction> {
    const input = await this.parseInput(actor, raw);
    try {
      return await this.backend.createTransaction(ownScope(actor), input);
    } catch (error) {
      this.toAppError(error);
    }
  }

  async updateTransaction(actor: UserActor, id: string, raw: unknown): Promise<Transaction> {
    const input = await this.parseInput(actor, raw, { editingTransactionId: id });
    try {
      return await this.backend.updateTransaction(ownScope(actor), id, input);
    } catch (error) {
      this.toAppError(error);
    }
  }

  async deleteTransaction(actor: UserActor, id: string): Promise<void> {
    try {
      await this.backend.deleteTransaction(ownScope(actor), id);
    } catch (error) {
      this.toAppError(error);
    }
  }

  async clearTransactions(actor: UserActor): Promise<void> {
    await this.backend.clearTransactions(ownScope(actor));
  }
}
