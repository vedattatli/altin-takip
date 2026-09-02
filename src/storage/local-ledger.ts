import {
  buildAccountingSummary,
  LedgerOversellError,
  parseLedgerCommand,
  replayProduct,
  resolveLedgerAmounts,
  type AccountingSummary,
  type LedgerAppendResult,
  type LedgerCommand,
  type LedgerEntry,
  type LedgerReplaceResult,
  type LedgerVoidResult,
  type PriceSnapshotInput,
  type PriceSnapshotRecord,
} from "@/domain/accounting";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import { getPriceProvider, isSnapshotStale, type PriceSnapshot } from "@/prices";
import { createId, nowISO } from "./types";

/**
 * Demo depoları (bellek / IndexedDB) için yerel defter motoru.
 *
 * Sunucu deposunda bu iş Postgres RPC'lerinde yapılır; burada aynı kurallar
 * (append-only, VOID/REPLACED, kronolojik negatif miktar kontrolü, idempotency)
 * tarayıcı içinde uygulanır. Demo verisi sunucuya gitmez.
 */

const ALL_PRODUCT_IDS = GOLD_PRODUCTS.map((product) => product.id);

export async function localSnapshot(): Promise<PriceSnapshot> {
  return getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
}

export function localSummary(entries: readonly LedgerEntry[], snapshot: PriceSnapshot | null): AccountingSummary {
  return buildAccountingSummary(entries, snapshot);
}

export class LocalLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLedgerError";
  }
}

function firstError(errors: Record<string, string | undefined>): string {
  return Object.values(errors).find(Boolean) ?? "İşlem verisi geçersiz.";
}

async function baselineFor(command: LedgerCommand): Promise<PriceSnapshotInput | null> {
  if (command.kind !== "OPENING_BALANCE" || command.costMethod !== "MARKET_BASELINE") return null;
  const snapshot = await localSnapshot();
  if (snapshot.status === "unavailable" || isSnapshotStale(snapshot)) return null;
  const quote = snapshot.quotes[command.productId];
  if (!quote || quote.status !== "ok") return null;
  return {
    productId: command.productId,
    liquidationPrice: quote.liquidationPrice,
    replacementPrice: quote.replacementPrice,
    provider: quote.provider,
    market: quote.market,
    currency: quote.currency,
    providerStatus: quote.status,
    isRealMarketData: snapshot.provider.isRealMarketData,
    providerTimestamp: quote.providerTimestamp,
    fetchedAt: quote.fetchedAt,
  };
}

function positionOrThrow(entries: readonly LedgerEntry[], productId: string) {
  try {
    return replayProduct(entries, productId);
  } catch (error) {
    if (error instanceof LedgerOversellError) {
      throw new LocalLedgerError(
        error.available === "0"
          ? "Elinizde satılabilir miktar bulunmuyor."
          : `Satış miktarı elinizdeki miktarı aşamaz. Satılabilir: ${error.available}.`,
      );
    }
    throw error;
  }
}

export interface LocalLedgerState {
  entries: LedgerEntry[];
  nextSequence: number;
}

async function buildEntry(
  state: LocalLedgerState,
  portfolioId: string,
  command: LedgerCommand,
  options: { replacesTransactionId?: string | null } = {},
): Promise<LedgerEntry> {
  const baselineSnapshot = await baselineFor(command);
  if (command.kind === "OPENING_BALANCE" && command.costMethod === "MARKET_BASELINE" && !baselineSnapshot) {
    throw new LocalLedgerError(
      "Güncel fiyat verisi kullanılamıyor. Takip başlangıcı yalnızca geçerli bir fiyatla oluşturulabilir.",
    );
  }
  const parsed = parseLedgerCommand(command, { baselineSnapshot });
  if (!parsed.ok) throw new LocalLedgerError(firstError(parsed.errors));
  const request = parsed.request;
  const amounts = resolveLedgerAmounts(request);
  const timestamp = nowISO();

  const snapshot: PriceSnapshotRecord | null = request.baselineSnapshot
    ? { ...request.baselineSnapshot, id: createId(), createdAt: timestamp }
    : null;

  return {
    id: createId(),
    portfolioId,
    productId: request.productId,
    kind: request.kind,
    quantity: request.quantity,
    unit: request.unit,
    occurredAt: request.occurredAt,
    pricingInputMode: request.pricingInputMode,
    ...amounts,
    costBasisOrigin: request.costBasisOrigin,
    priceSnapshotId: snapshot?.id ?? null,
    priceSnapshot: snapshot,
    note: request.note,
    status: "ACTIVE",
    voidedAt: null,
    voidReason: null,
    replacesTransactionId: options.replacesTransactionId ?? null,
    replacedByTransactionId: null,
    clientRequestId: request.clientRequestId,
    ledgerSequence: state.nextSequence,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function localAppend(
  state: LocalLedgerState,
  portfolioId: string,
  command: LedgerCommand,
): Promise<{ result: LedgerAppendResult; entries: LedgerEntry[] }> {
  if (command.clientRequestId) {
    const existing = state.entries.find((entry) => entry.clientRequestId === command.clientRequestId);
    if (existing) {
      return {
        result: { entry: existing, position: positionOrThrow(state.entries, existing.productId), replayed: true },
        entries: state.entries,
      };
    }
  }
  const entry = await buildEntry(state, portfolioId, command);
  const entries = [...state.entries, entry];
  const position = positionOrThrow(entries, entry.productId);
  return { result: { entry, position, replayed: false }, entries };
}

export function localVoid(
  state: LocalLedgerState,
  id: string,
  reason: string,
): { result: LedgerVoidResult; entries: LedgerEntry[] } {
  const target = state.entries.find((entry) => entry.id === id);
  if (!target) throw new LocalLedgerError("İşlem bulunamadı.");
  if (target.status !== "ACTIVE") throw new LocalLedgerError("Bu işlem zaten iptal edilmiş veya düzeltilmiş.");
  const voidedAt = nowISO();
  const voided: LedgerEntry = {
    ...target,
    status: "VOID",
    voidedAt,
    voidReason: reason.slice(0, 140) || "Kullanıcı iptal etti",
    updatedAt: voidedAt,
  };
  const entries = state.entries.map((entry) => (entry.id === id ? voided : entry));
  const position = positionOrThrow(entries, target.productId);
  return { result: { entry: voided, position }, entries };
}

export async function localReplace(
  state: LocalLedgerState,
  portfolioId: string,
  id: string,
  command: LedgerCommand,
): Promise<{ result: LedgerReplaceResult; entries: LedgerEntry[] }> {
  const target = state.entries.find((entry) => entry.id === id);
  if (!target) throw new LocalLedgerError("İşlem bulunamadı.");
  if (target.status !== "ACTIVE") throw new LocalLedgerError("Bu işlem zaten iptal edilmiş veya düzeltilmiş.");

  const created = await buildEntry(state, portfolioId, command, { replacesTransactionId: id });
  const voidedAt = nowISO();
  const replaced: LedgerEntry = {
    ...target,
    status: "REPLACED",
    voidedAt,
    voidReason: "Düzeltildi",
    replacedByTransactionId: created.id,
    updatedAt: voidedAt,
  };
  const entries = [...state.entries.map((entry) => (entry.id === id ? replaced : entry)), created];
  const positions = [positionOrThrow(entries, target.productId)];
  if (created.productId !== target.productId) positions.push(positionOrThrow(entries, created.productId));
  return { result: { voided: replaced, entry: created, positions }, entries };
}

export function localVoidAll(state: LocalLedgerState): { count: number; entries: LedgerEntry[] } {
  const timestamp = nowISO();
  let count = 0;
  const entries = state.entries.map((entry) => {
    if (entry.status !== "ACTIVE") return entry;
    count += 1;
    return { ...entry, status: "VOID" as const, voidedAt: timestamp, voidReason: "Tüm işlemler iptal edildi", updatedAt: timestamp };
  });
  return { count, entries };
}

export function sortLedgerDesc(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.ledgerSequence - a.ledgerSequence;
  });
}
