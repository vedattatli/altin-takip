import "server-only";

import { getProduct } from "@/domain/catalog";
import type { TransactionInput } from "@/domain/types";
import { validateTransaction } from "@/domain/validation";
import { badRequest } from "./auth/errors";
import { getAuthBackend } from "./auth";

/**
 * İstemciden gelen işlem gövdesini sunucuda yeniden doğrular.
 * İstemci doğrulaması yalnızca kullanıcı deneyimi içindir; güvenlik burada sağlanır.
 */
export async function parseTransactionInput(
  userId: string,
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
    unit: product?.unit ?? (body.unit === "adet" ? "adet" : "gram"),
    tradedAt: String(body.tradedAt ?? ""),
    unitPrice: Number(body.unitPrice),
    feeAmount: Number(body.feeAmount ?? 0),
    note: String(body.note ?? "").slice(0, 280),
  };

  const existing = await getAuthBackend().listTransactions(userId);
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
