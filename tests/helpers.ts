import { getProduct, GOLD_PRODUCTS, requireProduct } from "@/domain/catalog";
import type { Transaction, TransactionInput } from "@/domain/types";
import { MockPriceProvider } from "@/prices/mock-provider";
import type { PriceSnapshot } from "@/prices/types";

let counter = 0;

export function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  counter += 1;
  const productId = overrides.productId ?? "gram-altin";
  const product = requireProduct(productId);
  const timestamp = new Date(2026, 0, 1, 12, 0, counter).toISOString();

  return {
    id: overrides.id ?? `tx-${counter}`,
    portfolioId: "portfolio-1",
    productId,
    side: "buy",
    quantity: 1,
    unit: product.unit,
    tradedAt: "2026-01-15",
    unitPrice: 5000,
    feeAmount: 0,
    note: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function makeInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  const productId = overrides.productId ?? "gram-altin";
  // Doğrulama testleri bilerek katalogda olmayan kimlik de gönderebilir.
  const product = getProduct(productId);
  return {
    productId,
    side: "buy",
    quantity: 1,
    unit: product?.unit ?? "gram",
    tradedAt: "2026-01-15",
    unitPrice: 5000,
    feeAmount: 0,
    note: "",
    ...overrides,
  };
}

/** Testlerde sabit zamanlı, deterministik fiyat anlık görüntüsü. */
export async function fixedSnapshot(timestamp = Date.parse("2026-02-01T10:00:00Z")): Promise<PriceSnapshot> {
  const provider = new MockPriceProvider({
    now: () => timestamp,
    basePricePerPureGram: 5000,
  });
  return provider.getQuotes(GOLD_PRODUCTS.map((product) => product.id));
}
