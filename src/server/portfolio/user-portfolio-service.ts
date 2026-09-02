import "server-only";

import { getProduct } from "@/domain/catalog";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import { validateTransaction } from "@/domain/validation";
import { ownScope, type UserActor } from "@/server/auth/actor";
import {
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
} from "@/server/auth/backend";
import { badRequest, notFound, portfolioNotProvisioned } from "@/server/auth/errors";

/**
 * Kullanıcının KENDİ portföyü.
 *
 * Bu servisin hiçbir metodu hedef kullanıcı kimliği ALMAZ. Erişilen satırlar
 * her zaman `ownScope(actor)` ile belirlenir; dolayısıyla bir route gövdeden
 * gelen bir kimlikle başka kullanıcının verisine ulaşamaz.
 *
 * Başka kullanıcıyı hedefleyen işlemler AdminService'tedir.
 */
/** Sayısal alanlar: yalnızca sonlu sayı veya sayı biçimli dize kabul edilir. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export class UserPortfolioService {
  constructor(private readonly backend: AuthBackend) {}

  /** Salt okuma: hiçbir koşulda veritabanını değiştirmez. */
  async getPortfolio(actor: UserActor): Promise<PortfolioMeta> {
    try {
      return await this.backend.getPortfolio(ownScope(actor));
    } catch (error) {
      this.toAppError(error);
    }
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
    try {
      return await this.backend.updatePortfolio(ownScope(actor), clean);
    } catch (error) {
      this.toAppError(error);
    }
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

    // Ürün katalogda YOKSA açıkça reddedilir; birim istemciden alınmaz.
    const productId = typeof body.productId === "string" ? body.productId : "";
    const product = getProduct(productId);
    if (!product) throw badRequest("Lütfen listeden geçerli bir altın türü seçin.");

    // side yalnızca "buy" veya "sell" olabilir; başka değer sessizce çevrilmez.
    if (body.side !== "buy" && body.side !== "sell") {
      throw badRequest("İşlem türü yalnızca alış veya satış olabilir.");
    }

    const quantity = toFiniteNumber(body.quantity);
    const unitPrice = toFiniteNumber(body.unitPrice);
    const feeAmount = body.feeAmount === undefined ? 0 : toFiniteNumber(body.feeAmount);

    if (quantity === null || quantity <= 0) throw badRequest("Miktar sıfırdan büyük olmalıdır.");
    if (unitPrice === null || unitPrice <= 0) {
      throw badRequest("Birim fiyat sıfırdan büyük olmalıdır.");
    }
    if (feeAmount === null || feeAmount < 0) {
      throw badRequest("İşçilik/komisyon negatif olamaz.");
    }

    const input: TransactionInput = {
      productId,
      side: body.side,
      quantity,
      unit: product.unit,
      tradedAt: typeof body.tradedAt === "string" ? body.tradedAt : "",
      unitPrice,
      feeAmount,
      note: typeof body.note === "string" ? body.note.slice(0, 280) : "",
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

  /** Arka uç hatalarını HTTP hatalarına çevirir; iç detay sızdırmaz. */
  private toAppError(error: unknown): never {
    if (error instanceof OversellError) {
      throw badRequest("Satış miktarı elinizdeki miktarı aşamaz.");
    }
    if (error instanceof PortfolioNotProvisionedError) {
      throw portfolioNotProvisioned();
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
