import {
  buildAccountingSummary,
  LedgerOversellError,
  normalizeLedgerEntry,
  parseLedgerCommand,
  replayProduct,
  requestFingerprint,
  resolveLedgerAmounts,
  sortLedgerDesc,
  validatePriceSnapshotInput,
  type AccountingSummary,
  type LedgerAppendRequest,
  type LedgerAppendResult,
  type LedgerCommand,
  type LedgerEntry,
  type LedgerReplaceResult,
  type LedgerVoidResult,
  type PriceSnapshotInput,
  type PriceSnapshotRecord,
  type ProductPosition,
} from "@/domain/accounting";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import { getPriceProvider, validateUsableQuote, type PriceSnapshot } from "@/prices";
import { createId, nowISO } from "./types";

/**
 * Demo depoları (bellek / IndexedDB) için yerel defter motoru.
 *
 * Sunucu deposunda bu iş Postgres RPC'lerinde yapılır; burada AYNI domain sözleşmesi
 * (append-only, VOID/REPLACED, kronolojik negatif miktar kontrolü, anlık görüntü
 * doğrulaması, idempotency: aynı kimlik + aynı içerik → replay, farklı içerik → conflict)
 * tarayıcı içinde uygulanır. Demo verisi sunucuya gitmez.
 */

const ALL_PRODUCT_IDS = GOLD_PRODUCTS.map((product) => product.id);

export { sortLedgerDesc };

/** Depoda saklanan kayıt: idempotency parmak izi arayüze çıkmaz. */
export interface LocalLedgerEntry extends LedgerEntry {
  requestFingerprint?: string;
}

export function stripLocalEntry(entry: LocalLedgerEntry): LedgerEntry {
  const { requestFingerprint: _fingerprint, ...rest } = entry;
  return rest;
}

export async function localSnapshot(): Promise<PriceSnapshot> {
  return getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
}

export function localSummary(entries: readonly LedgerEntry[], snapshot: PriceSnapshot | null): AccountingSummary {
  return buildAccountingSummary(entries, snapshot);
}

export class LocalLedgerError extends Error {
  constructor(
    message: string,
    readonly code: string = "ledger_error",
  ) {
    super(message);
    this.name = "LocalLedgerError";
  }
}

/** Aynı istek kimliği farklı içerikle kullanıldı (sunucudaki ALTIN_IDEMPOTENCY_CONFLICT karşılığı). */
export class LocalIdempotencyConflictError extends LocalLedgerError {
  constructor(clientRequestId: string) {
    super(
      `"${clientRequestId}" istek kimliği daha önce farklı bir içerikle kullanılmış; işlem tekrar oluşturulmadı.`,
      "idempotency_conflict",
    );
    this.name = "LocalIdempotencyConflictError";
  }
}

function firstError(errors: Record<string, string | undefined>): string {
  return Object.values(errors).find(Boolean) ?? "İşlem verisi geçersiz.";
}

async function baselineFor(command: LedgerCommand): Promise<PriceSnapshotInput | null> {
  if (command.kind !== "OPENING_BALANCE" || command.costMethod !== "MARKET_BASELINE") return null;
  const snapshot = await localSnapshot();
  const now = Date.now();
  // MERKEZİ quote doğrulaması: sunucu servisiyle aynı kurallar.
  const usable = validateUsableQuote(snapshot, snapshot.quotes[command.productId], command.productId, now);
  if (!usable.ok) return null;
  const quote = usable.quote;
  const input: PriceSnapshotInput = {
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
    staleAfterMs: snapshot.provider.staleAfterMs,
  };
  return validatePriceSnapshotInput(input, command.productId, now) === null ? input : null;
}

function positionOrThrow(entries: readonly LedgerEntry[], productId: string): ProductPosition {
  try {
    return replayProduct(entries, productId);
  } catch (error) {
    if (error instanceof LedgerOversellError) {
      throw new LocalLedgerError(
        error.available === "0"
          ? "Elinizde satılabilir miktar bulunmuyor."
          : `Satış miktarı elinizdeki miktarı aşamaz. Satılabilir: ${error.available}.`,
        "oversell",
      );
    }
    throw error;
  }
}

export interface LocalLedgerState {
  entries: LocalLedgerEntry[];
  nextSequence: number;
}

/** Eski biçimde saklanmış kayıtları güncel biçime getirir (IndexedDB / bellek). */
export function normalizeLocalEntries(entries: readonly unknown[]): LocalLedgerEntry[] {
  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => normalizeLedgerEntry(entry) as LocalLedgerEntry);
}

/** Komutu doğrular ve arka uç isteğine çevirir (anlık görüntü dâhil). */
async function requestOf(command: LedgerCommand): Promise<LedgerAppendRequest> {
  const baselineSnapshot = await baselineFor(command);
  if (command.kind === "OPENING_BALANCE" && command.costMethod === "MARKET_BASELINE" && !baselineSnapshot) {
    throw new LocalLedgerError(
      "Güncel fiyat verisi kullanılamıyor. Takip başlangıcı yalnızca geçerli bir fiyatla oluşturulabilir.",
      "price_unavailable",
    );
  }
  const parsed = parseLedgerCommand(command, { baselineSnapshot });
  if (!parsed.ok) throw new LocalLedgerError(firstError(parsed.errors), "validation");
  return parsed.request;
}

function buildEntry(
  state: LocalLedgerState,
  portfolioId: string,
  request: LedgerAppendRequest,
  options: { replacesTransactionId?: string | null } = {},
): LocalLedgerEntry {
  const amounts = resolveLedgerAmounts(request);
  const timestamp = nowISO();

  const snapshot: PriceSnapshotRecord | null = request.baselineSnapshot
    ? {
        productId: request.baselineSnapshot.productId,
        liquidationPrice: request.baselineSnapshot.liquidationPrice,
        replacementPrice: request.baselineSnapshot.replacementPrice,
        provider: request.baselineSnapshot.provider,
        market: request.baselineSnapshot.market,
        currency: request.baselineSnapshot.currency,
        providerStatus: request.baselineSnapshot.providerStatus,
        isRealMarketData: request.baselineSnapshot.isRealMarketData,
        providerTimestamp: request.baselineSnapshot.providerTimestamp,
        fetchedAt: request.baselineSnapshot.fetchedAt,
        id: createId(),
        createdAt: timestamp,
      }
    : null;

  return {
    id: createId(),
    portfolioId,
    productId: request.productId,
    kind: request.kind,
    quantity: request.quantity,
    unit: request.unit,
    occurredAt: request.occurredAt,
    occurredTime: request.occurredTime,
    occurredAtInstant: request.occurredAtInstant,
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
    requestFingerprint: requestFingerprint(request),
  };
}

/** Aynı istek kimliğiyle kayıt varsa içerik karşılaştırılır: aynı → kayıt, farklı → conflict. */
function findReplay(
  state: LocalLedgerState,
  request: LedgerAppendRequest,
): LocalLedgerEntry | null {
  if (!request.clientRequestId) return null;
  const existing = state.entries.find((entry) => entry.clientRequestId === request.clientRequestId);
  if (!existing) return null;
  if (existing.requestFingerprint !== requestFingerprint(request)) {
    throw new LocalIdempotencyConflictError(request.clientRequestId);
  }
  return existing;
}

export async function localAppend(
  state: LocalLedgerState,
  portfolioId: string,
  command: LedgerCommand,
): Promise<{ result: LedgerAppendResult; entries: LocalLedgerEntry[] }> {
  const request = await requestOf(command);
  const existing = findReplay(state, request);
  if (existing) {
    return {
      result: {
        entry: stripLocalEntry(existing),
        position: positionOrThrow(state.entries, existing.productId),
        replayed: true,
      },
      entries: state.entries,
    };
  }
  const entry = buildEntry(state, portfolioId, request);
  const entries = [...state.entries, entry];
  const position = positionOrThrow(entries, entry.productId);
  return { result: { entry: stripLocalEntry(entry), position, replayed: false }, entries };
}

export function localVoid(
  state: LocalLedgerState,
  id: string,
  reason: string,
): { result: LedgerVoidResult; entries: LocalLedgerEntry[] } {
  const target = state.entries.find((entry) => entry.id === id);
  if (!target) throw new LocalLedgerError("İşlem bulunamadı.", "not_found");
  if (target.status !== "ACTIVE") {
    throw new LocalLedgerError("Bu işlem zaten iptal edilmiş veya düzeltilmiş.", "not_active");
  }
  const voidedAt = nowISO();
  const voided: LocalLedgerEntry = {
    ...target,
    status: "VOID",
    voidedAt,
    voidReason: reason.slice(0, 140) || "Kullanıcı iptal etti",
    updatedAt: voidedAt,
  };
  const entries = state.entries.map((entry) => (entry.id === id ? voided : entry));
  const position = positionOrThrow(entries, target.productId);
  return { result: { entry: stripLocalEntry(voided), position }, entries };
}

/** Replay/ilk yanıt AYNI biçim: [eski ürün pozisyonu, (farklıysa) yeni ürün pozisyonu]. */
function replacePositions(entries: readonly LedgerEntry[], oldProductId: string, newProductId: string) {
  const positions = [positionOrThrow(entries, oldProductId)];
  if (newProductId !== oldProductId) positions.push(positionOrThrow(entries, newProductId));
  return positions;
}

export async function localReplace(
  state: LocalLedgerState,
  portfolioId: string,
  id: string,
  command: LedgerCommand,
): Promise<{ result: LedgerReplaceResult; entries: LocalLedgerEntry[] }> {
  const target = state.entries.find((entry) => entry.id === id);
  if (!target) throw new LocalLedgerError("İşlem bulunamadı.", "not_found");
  const request = await requestOf(command);

  // Idempotent tekrar: aynı kimlik + aynı içerik + aynı hedef → mevcut sonuç.
  const existing = findReplay(state, request);
  if (existing) {
    if (existing.replacesTransactionId !== id) {
      throw new LocalIdempotencyConflictError(request.clientRequestId ?? "");
    }
    return {
      result: {
        voided: stripLocalEntry(target),
        entry: stripLocalEntry(existing),
        positions: replacePositions(state.entries, target.productId, existing.productId),
      },
      entries: state.entries,
    };
  }

  if (target.status !== "ACTIVE") {
    throw new LocalLedgerError("Bu işlem zaten iptal edilmiş veya düzeltilmiş.", "not_active");
  }

  const created = buildEntry(state, portfolioId, request, { replacesTransactionId: id });
  const voidedAt = nowISO();
  const replaced: LocalLedgerEntry = {
    ...target,
    status: "REPLACED",
    voidedAt,
    voidReason: "Düzeltildi",
    replacedByTransactionId: created.id,
    updatedAt: voidedAt,
  };
  const entries = [...state.entries.map((entry) => (entry.id === id ? replaced : entry)), created];
  const positions = replacePositions(entries, target.productId, created.productId);
  return { result: { voided: stripLocalEntry(replaced), entry: stripLocalEntry(created), positions }, entries };
}

export function localVoidAll(state: LocalLedgerState): { count: number; entries: LocalLedgerEntry[] } {
  const timestamp = nowISO();
  let count = 0;
  const entries = state.entries.map((entry) => {
    if (entry.status !== "ACTIVE") return entry;
    count += 1;
    return { ...entry, status: "VOID" as const, voidedAt: timestamp, voidReason: "Tüm işlemler iptal edildi", updatedAt: timestamp };
  });
  return { count, entries };
}
