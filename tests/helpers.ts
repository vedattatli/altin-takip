import {
  occurredAtInstantISO,
  resolveLedgerAmounts,
  type BuyCommand,
  type LedgerEntry,
  type OpeningBalanceCommand,
  type SellCommand,
} from "@/domain/accounting";
import { GOLD_PRODUCTS, requireProduct } from "@/domain/catalog";
import { MOCK_PROVIDER_META, MockPriceProvider } from "@/prices/mock-provider";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";

let counter = 0;

/**
 * Test defter kaydı üretir. Tutarlar gerçek motorla (resolveLedgerAmounts)
 * hesaplanır; böylece testler kendi kendini tutarlı biçimde kurar.
 */
export function makeEntry(
  overrides: Partial<LedgerEntry> & { unitPrice?: string; totalAmount?: string } = {},
): LedgerEntry {
  counter += 1;
  const productId = overrides.productId ?? "gram-altin";
  const product = requireProduct(productId);
  const kind = overrides.kind ?? "BUY";
  const quantity = overrides.quantity ?? "1";
  const mode = overrides.pricingInputMode ?? "UNIT_PRICE";
  const timestamp = new Date(Date.UTC(2026, 0, 1, 12, 0, counter)).toISOString();

  const amounts = resolveLedgerAmounts({
    kind,
    quantity,
    pricingInputMode: mode,
    unitPrice: overrides.unitPrice ?? (mode === "UNIT_PRICE" ? "5000" : null),
    totalAmount: overrides.totalAmount ?? null,
    fees: overrides.fees ?? "0",
    workmanship: overrides.workmanship ?? "0",
    baselineSnapshot:
      mode === "MARKET_BASELINE"
        ? {
            productId,
            liquidationPrice: overrides.unitPrice ?? "5000",
            replacementPrice: overrides.unitPrice ?? "5000",
            provider: "mock",
            market: "TEST",
            currency: "TRY",
            providerStatus: "ok",
            isRealMarketData: false,
            providerTimestamp: timestamp,
            fetchedAt: timestamp,
          }
        : null,
  });

  const { unitPrice: _u, totalAmount: _t, ...rest } = overrides;
  const occurredAt = overrides.occurredAt ?? "2026-01-15";
  const occurredTime = overrides.occurredTime ?? null;
  return {
    id: overrides.id ?? `tx-${counter}`,
    portfolioId: "portfolio-1",
    productId,
    kind,
    quantity,
    unit: product.unit,
    occurredAt,
    occurredTime,
    occurredAtInstant: occurredAtInstantISO(occurredAt, occurredTime) ?? occurredAt,
    pricingInputMode: mode,
    ...amounts,
    costBasisOrigin: overrides.costBasisOrigin ?? (mode === "MARKET_BASELINE" ? "MARKET_BASELINE" : "ACTUAL"),
    priceSnapshotId: null,
    priceSnapshot: null,
    note: "",
    status: "ACTIVE",
    voidedAt: null,
    voidReason: null,
    replacesTransactionId: null,
    replacedByTransactionId: null,
    clientRequestId: null,
    ledgerSequence: counter,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...rest,
  };
}

export function buyCommand(overrides: Partial<BuyCommand> = {}): BuyCommand {
  return {
    kind: "BUY",
    productId: "gram-altin",
    quantity: "1",
    occurredAt: "2026-01-15",
    pricingInputMode: "UNIT_PRICE",
    unitPrice: "5000",
    ...overrides,
  };
}

export function sellCommand(overrides: Partial<SellCommand> = {}): SellCommand {
  return {
    kind: "SELL",
    productId: "gram-altin",
    quantity: "1",
    occurredAt: "2026-01-20",
    pricingInputMode: "UNIT_PRICE",
    unitPrice: "5200",
    ...overrides,
  };
}

export function openingCommand(overrides: Partial<OpeningBalanceCommand> = {}): OpeningBalanceCommand {
  return {
    kind: "OPENING_BALANCE",
    productId: "gram-altin",
    quantity: "10",
    costMethod: "ACTUAL",
    costInputMode: "AVERAGE_UNIT_COST",
    costAmount: "5000",
    ...overrides,
  };
}

/** Belirli ürünler için sabit fiyatlı anlık görüntü. */
export function snapshotWith(
  prices: Record<string, { liquidation: string; replacement: string }>,
  options: { fetchedAt?: string; status?: PriceQuote["status"] } = {},
): PriceSnapshot {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const quotes: Record<string, PriceQuote> = {};
  for (const [productId, price] of Object.entries(prices)) {
    quotes[productId] = {
      productId,
      liquidationPrice: price.liquidation,
      replacementPrice: price.replacement,
      currency: "TRY",
      market: "TEST",
      provider: "mock",
      providerTimestamp: fetchedAt,
      fetchedAt,
      status: options.status ?? "ok",
    };
  }
  return { provider: MOCK_PROVIDER_META, quotes, fetchedAt, status: "ok", error: null };
}

/** Testlerde sabit zamanlı, deterministik fiyat anlık görüntüsü (mock sağlayıcı). */
export async function fixedSnapshot(timestamp = Date.parse("2026-02-01T10:00:00Z")): Promise<PriceSnapshot> {
  const provider = new MockPriceProvider({
    now: () => timestamp,
    basePricePerPureGram: 5000,
  });
  return provider.getQuotes(GOLD_PRODUCTS.map((product) => product.id));
}
