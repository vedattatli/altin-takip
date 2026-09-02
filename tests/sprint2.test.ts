import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import {
  buildAccountingSummary,
  parseLedgerCommand,
  requestFingerprint,
  resolveLedgerAmounts,
  validatePriceSnapshotInput,
  valuePositions,
  type LedgerAppendRequest,
  type PriceSnapshotInput,
} from "@/domain/accounting";
import { MOCK_PROVIDER_META, MockPriceProvider } from "@/prices/mock-provider";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";
import { validateUsableQuote } from "@/prices/validate";
import { IdempotencyConflictError } from "@/server/auth/backend";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { LocalIdempotencyConflictError, localAppend, type LocalLedgerState } from "@/storage/local-ledger";
import { MemoryPortfolioRepository } from "@/storage/memory-repository";
import { scopeOf, userActor } from "./actors";
import { buyCommand, makeEntry, sellCommand, snapshotWith } from "./helpers";

/**
 * SPRINT 2 — merkezi fiyat doğrulaması, değerleme/portföy durumları, idempotency eşitliği,
 * sayısal sınırlar ve defter sürümü (senkronizasyon sinyali).
 */

const NOW = Date.parse("2026-03-01T10:00:00Z");
const nowIso = new Date(NOW).toISOString();
const MINUTE = 60_000;

function quoteFor(productId: string, overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    productId,
    liquidationPrice: "5000",
    replacementPrice: "5100",
    currency: "TRY",
    market: "TEST",
    provider: "mock",
    providerTimestamp: nowIso,
    fetchedAt: nowIso,
    status: "ok",
    ...overrides,
  };
}

function snapshotOf(quotes: PriceQuote[], overrides: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    provider: MOCK_PROVIDER_META,
    quotes: Object.fromEntries(quotes.map((quote) => [quote.productId, quote])),
    fetchedAt: nowIso,
    status: "ok",
    error: null,
    ...overrides,
  };
}

describe("1. merkezi quote doğrulaması (validateUsableQuote)", () => {
  it("geçerli quote kabul edilir; 5 dakikalık küçük saat farkı tolere edilir", () => {
    const snapshot = snapshotOf([quoteFor("gram-altin")]);
    expect(validateUsableQuote(snapshot, snapshot.quotes["gram-altin"], "gram-altin", NOW).ok).toBe(true);
    const slightlyAhead = new Date(NOW + 2 * MINUTE).toISOString();
    const ahead = snapshotOf([quoteFor("gram-altin", { providerTimestamp: slightlyAhead, fetchedAt: slightlyAhead })], {
      fetchedAt: slightlyAhead,
    });
    expect(validateUsableQuote(ahead, ahead.quotes["gram-altin"], "gram-altin", NOW).ok).toBe(true);
  });

  it("providerTimestamp 2 saat eskiyse veri şimdi çekilmiş görünse bile reddedilir; fetchedAt bayatsa reddedilir", () => {
    const oldProvider = new Date(NOW - 2 * 60 * MINUTE).toISOString();
    const snapshot = snapshotOf([quoteFor("gram-altin", { providerTimestamp: oldProvider })]);
    const result = validateUsableQuote(snapshot, snapshot.quotes["gram-altin"], "gram-altin", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");

    const staleFetched = new Date(NOW - 10 * MINUTE).toISOString();
    const snapshot2 = snapshotOf([quoteFor("gram-altin", { fetchedAt: staleFetched })]);
    const result2 = validateUsableQuote(snapshot2, snapshot2.quotes["gram-altin"], "gram-altin", NOW);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe("stale");

    const snapshot3 = snapshotOf([quoteFor("gram-altin")], { fetchedAt: staleFetched });
    expect(validateUsableQuote(snapshot3, snapshot3.quotes["gram-altin"], "gram-altin", NOW).ok).toBe(false);
  });

  it("başka ürün, uyuşmayan sağlayıcı/piyasa, ters makas, yanlış para birimi ve gelecek zaman reddedilir", () => {
    const base = snapshotOf([quoteFor("gram-altin")]);
    const wrongProduct = quoteFor("yeni-ceyrek");
    expect(validateUsableQuote(base, wrongProduct, "gram-altin", NOW)).toMatchObject({ ok: false, reason: "product_mismatch" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { provider: "baska" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "provider_mismatch" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { market: "BASKA" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "market_mismatch" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { replacementPrice: "4999" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "spread" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { currency: "USD" as "TRY" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "currency" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { liquidationPrice: "0" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "price" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { status: "stale" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "status" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { provider: "" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "provider" });
    const future = new Date(NOW + 10 * MINUTE).toISOString();
    expect(validateUsableQuote(base, quoteFor("gram-altin", { providerTimestamp: future }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "future" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { fetchedAt: future }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "future" });
    const futureSnapshot = snapshotOf([quoteFor("gram-altin")], { fetchedAt: future });
    expect(validateUsableQuote(futureSnapshot, futureSnapshot.quotes["gram-altin"], "gram-altin", NOW)).toMatchObject({ ok: false, reason: "future" });
    expect(validateUsableQuote(base, quoteFor("gram-altin", { providerTimestamp: "dün" }), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "timestamp_invalid" });
    expect(validateUsableQuote(base, undefined, "gram-altin", NOW)).toMatchObject({ ok: false, reason: "missing" });
    expect(validateUsableQuote(null, quoteFor("gram-altin"), "gram-altin", NOW)).toMatchObject({ ok: false, reason: "snapshot_unavailable" });
  });

  it("fetchedAt providerTimestamp'tan açıklanamayan biçimde önce olamaz", () => {
    const providerLater = new Date(NOW).toISOString();
    const fetchedEarlier = new Date(NOW - 6 * MINUTE).toISOString();
    const snapshot = snapshotOf([quoteFor("gram-altin", { providerTimestamp: providerLater, fetchedAt: fetchedEarlier })]);
    const result = validateUsableQuote(snapshot, snapshot.quotes["gram-altin"], "gram-altin", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["stale", "fetched_before_provider"]).toContain(result.reason);
    const within = new Date(NOW - 2 * MINUTE).toISOString();
    const okSnapshot = snapshotOf([quoteFor("gram-altin", { providerTimestamp: providerLater, fetchedAt: within })]);
    expect(validateUsableQuote(okSnapshot, okSnapshot.quotes["gram-altin"], "gram-altin", NOW).ok).toBe(true);
  });

  it("MARKET_BASELINE anlık görüntüsü aynı zaman kurallarını uygular (staleAfterMs ile)", () => {
    const base: PriceSnapshotInput = {
      productId: "gram-altin",
      liquidationPrice: "5000",
      replacementPrice: "5100",
      provider: "mock",
      market: "TEST",
      currency: "TRY",
      providerStatus: "ok",
      isRealMarketData: false,
      providerTimestamp: nowIso,
      fetchedAt: nowIso,
      staleAfterMs: MOCK_PROVIDER_META.staleAfterMs,
    };
    expect(validatePriceSnapshotInput(base, "gram-altin", NOW)).toBeNull();
    expect(validatePriceSnapshotInput({ ...base, providerTimestamp: new Date(NOW - 120 * MINUTE).toISOString() }, "gram-altin", NOW)).toMatch(/Sağlayıcı fiyat zamanı eski/);
    expect(validatePriceSnapshotInput({ ...base, fetchedAt: new Date(NOW - 10 * MINUTE).toISOString(), providerTimestamp: new Date(NOW - 10 * MINUTE).toISOString() }, "gram-altin", NOW)).toMatch(/bayat/);
    expect(validatePriceSnapshotInput({ ...base, fetchedAt: new Date(NOW - 10 * MINUTE).toISOString(), providerTimestamp: new Date(NOW - 10 * MINUTE).toISOString(), staleAfterMs: undefined }, "gram-altin", NOW)).toBeNull();
    expect(validatePriceSnapshotInput({ ...base, fetchedAt: new Date(NOW - 6 * MINUTE).toISOString(), staleAfterMs: undefined }, "gram-altin", NOW)).toMatch(/önce çekilmiş/);
    const slight = new Date(NOW + 3 * MINUTE).toISOString();
    expect(validatePriceSnapshotInput({ ...base, providerTimestamp: slight, fetchedAt: slight }, "gram-altin", NOW)).toBeNull();
  });

  it("test sağlayıcısı belirli ürünler için fiyat üretmeyebilir (uydurma fiyat yok)", async () => {
    const provider = new MockPriceProvider({ now: () => NOW, unavailableProducts: ["resat-altin"] });
    const snapshot = await provider.getQuotes(["gram-altin", "resat-altin"]);
    expect(snapshot.status).toBe("partial");
    expect(snapshot.quotes["resat-altin"]).toBeUndefined();
    expect(snapshot.quotes["gram-altin"]).toBeDefined();
  });
});

describe("2. değerleme durumu ve 3. portföy durumu", () => {
  const openGram = makeEntry({ productId: "gram-altin", quantity: "2", unitPrice: "5000", occurredAt: "2026-01-10" });
  const openResat = makeEntry({ productId: "resat-altin", quantity: "1", unitPrice: "40000", occurredAt: "2026-01-11" });

  it("A. hiç işlem yok → NEVER_USED, valuationStatus empty, 0 TL", () => {
    const summary = buildAccountingSummary([], snapshotWith({}, { fetchedAt: nowIso }), NOW);
    expect(summary.portfolioState).toBe("NEVER_USED");
    expect(summary.valuationStatus).toBe("empty");
    expect(summary.hasLedgerActivity).toBe(false);
    expect(summary.totalLiquidationValue).toBe("0");
  });

  it("B. bütün fiyatlar kullanılabilir → full", () => {
    const summary = buildAccountingSummary(
      [openGram, openResat],
      snapshotWith({ "gram-altin": { liquidation: "5000", replacement: "5100" }, "resat-altin": { liquidation: "41000", replacement: "42000" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.portfolioState).toBe("OPEN");
    expect(summary.valuationStatus).toBe("full");
    expect(summary.activePositionCount).toBe(2);
  });

  it("C. bazı fiyatlar → partial; yalnızca fiyatı bulunan pozisyonların toplamı", () => {
    const summary = buildAccountingSummary(
      [openGram, openResat],
      snapshotWith({ "gram-altin": { liquidation: "5000", replacement: "5100" } }, { fetchedAt: nowIso }),
      NOW,
    );
    expect(summary.valuationStatus).toBe("partial");
    expect(summary.totalLiquidationValue).toBe("10000");
    expect(summary.unpricedCostBasis).toBe("40000");
  });

  it("D. açık pozisyon var, hiç kullanılabilir fiyat yok → none; meta 'ok' olsa bile", () => {
    const snapshot = snapshotWith({ "yeni-ceyrek": { liquidation: "11000", replacement: "11300" } }, { fetchedAt: nowIso });
    const summary = buildAccountingSummary([openGram, openResat], snapshot, NOW);
    expect(summary.priceStatus).toBe("ok");
    expect(summary.valuationStatus).toBe("none");
    expect(summary.valuationCoverage).toBe("none");
    expect(summary.portfolioState).toBe("OPEN");
    expect(summary.totalRemainingCostBasis).toBe("50000");
    expect(summary.pricedPositionCount).toBe(0);
    // Bayat meta → hiçbir quote kullanılabilir değil → none
    const stale = buildAccountingSummary(
      [openGram],
      snapshotWith({ "gram-altin": { liquidation: "5000", replacement: "5100" } }, { fetchedAt: new Date(NOW - 10 * MINUTE).toISOString() }),
      NOW,
    );
    expect(stale.valuationStatus).toBe("none");
    expect(stale.priceStatus).toBe("stale");
  });

  it("CLOSED: geçmiş işlem var, açık pozisyon yok; gerçekleşmiş K/Z korunur; fiyat yokluğu gizlemez", () => {
    const entries = [
      openGram,
      makeEntry({ productId: "gram-altin", kind: "SELL", quantity: "2", unitPrice: "5500", occurredAt: "2026-01-20" }),
    ];
    const summary = buildAccountingSummary(entries, null, NOW);
    expect(summary.portfolioState).toBe("CLOSED");
    expect(summary.activePositionCount).toBe(0);
    expect(summary.hasLedgerActivity).toBe(true);
    expect(summary.ledgerEntryCount).toBe(2);
    expect(summary.totalRealizedPnl).toBe("1000");
    expect(summary.totalPnl).toBe("1000");
    expect(summary.valuationStatus).toBe("empty");
    // Bütün kayıtlar iptal edilse bile defter etkinliği vardır → CLOSED (NEVER_USED değil)
    const voided = entries.map((entry) => ({ ...entry, status: "VOID" as const }));
    expect(buildAccountingSummary(voided, null, NOW).portfolioState).toBe("CLOSED");
    // Pozisyon satırlarından (sunucu yolu) da aynı sonuç: aktif sayım > 0, miktar 0
    const fromPositions = valuePositions(
      [
        {
          productId: "gram-altin",
          quantity: "0",
          remainingCostBasis: "0",
          averageCost: null,
          realizedPnl: "1000",
          holdingCostOrigins: { actual: false, estimated: false, baseline: false },
          realizedPnlOrigins: { actual: true, estimated: false, baseline: false },
          activeTransactionCount: 2,
          lastLedgerSequence: 2,
        },
      ],
      null,
      NOW,
    );
    expect(fromPositions.portfolioState).toBe("CLOSED");
    expect(valuePositions([], null, NOW, { ledgerEntryCount: 3 }).portfolioState).toBe("CLOSED");
    expect(valuePositions([], null, NOW).portfolioState).toBe("NEVER_USED");
  });
});

describe("4. yerel demo ile sunucu idempotency davranışı", () => {
  const portfolioId = "portfolio-1";

  it("aynı kimlik + aynı içerik replay; farklı içerik conflict (bellek/IndexedDB motoru)", async () => {
    let state: LocalLedgerState = { entries: [], nextSequence: 1 };
    const command = buyCommand({ quantity: "2", clientRequestId: "req-demo-000001" });
    const first = await localAppend(state, portfolioId, command);
    state = { entries: first.entries, nextSequence: 2 };
    const second = await localAppend(state, portfolioId, command);
    expect(second.result.replayed).toBe(true);
    expect(second.result.entry.id).toBe(first.result.entry.id);
    expect(second.entries).toHaveLength(1);
    await expect(localAppend(state, portfolioId, { ...command, quantity: "3" })).rejects.toBeInstanceOf(
      LocalIdempotencyConflictError,
    );
    // Parmak izi arayüze çıkmaz
    expect("requestFingerprint" in first.result.entry).toBe(false);
  });

  it("bellek deposu aynı sözleşmeyi uygular; replace replay ilk yanıtla aynı biçimdedir (ürün değişince iki pozisyon)", async () => {
    const repo = new MemoryPortfolioRepository();
    const command = buyCommand({ quantity: "2", clientRequestId: "req-mem-000001" });
    const first = await repo.appendTransaction(command);
    const second = await repo.appendTransaction(command);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await repo.listLedger()).toHaveLength(1);
    await expect(repo.appendTransaction({ ...command, quantity: "5" })).rejects.toBeInstanceOf(LocalIdempotencyConflictError);

    const replacement = buyCommand({ productId: "has-altin", quantity: "1", clientRequestId: "req-mem-replace-1" });
    const replaced = await repo.replaceTransaction(first.entry.id, replacement);
    const replayed = await repo.replaceTransaction(first.entry.id, replacement);
    expect(replaced.positions.map((position) => position.productId)).toEqual(["gram-altin", "has-altin"]);
    expect(replayed.positions.map((position) => position.productId)).toEqual(["gram-altin", "has-altin"]);
    expect(replayed.entry.id).toBe(replaced.entry.id);
    expect(replayed.voided.status).toBe("REPLACED");
    expect(JSON.stringify(replayed.positions)).toBe(JSON.stringify(replaced.positions));
    await expect(repo.replaceTransaction(first.entry.id, { ...replacement, quantity: "2" })).rejects.toBeInstanceOf(
      LocalIdempotencyConflictError,
    );
    expect(await repo.listLedger()).toHaveLength(2);
  });

  it("parmak izi kanonik alan kümesine dayanır: anahtar sırası ve anlık görüntü fark yaratmaz", () => {
    const parsed = parseLedgerCommand(buyCommand({ clientRequestId: "req-fp-000001" }), { now: new Date(NOW) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const request = parsed.request;
    const shuffled = Object.fromEntries(Object.entries(request).reverse()) as unknown as LedgerAppendRequest;
    expect(requestFingerprint(shuffled)).toBe(requestFingerprint(request));
    expect(requestFingerprint({ ...request, clientRequestId: "req-fp-000002" })).toBe(requestFingerprint(request));
    expect(requestFingerprint({ ...request, quantity: "2" })).not.toBe(requestFingerprint(request));
  });
});

describe("4b/7. yerel arka uç: replace replay biçimi ve defter sürümü", () => {
  let backend: LocalAuthBackend;
  let service: UserPortfolioService;
  let user: UserProfile;

  beforeEach(async () => {
    backend = new LocalAuthBackend({ inMemory: true });
    service = new UserPortfolioService(backend);
    user = await backend.createUser({ username: "ayse", displayName: "Ayşe", temporaryPassword: "Kuyumcu7Defter", role: "user" });
  });

  it("sürüm yalnızca gerçek değişiklikte artar; replay ve başarısız işlem artırmaz", async () => {
    const actor = userActor(user);
    expect((await service.getLedgerRevision(actor)).revision).toBe(0);
    const command = buyCommand({ quantity: "2", clientRequestId: "req-rev-000001" });
    await service.appendTransaction(actor, command);
    expect((await service.getLedgerRevision(actor)).revision).toBe(1);
    const replay = await service.appendTransaction(actor, command);
    expect(replay.replayed).toBe(true);
    expect((await service.getLedgerRevision(actor)).revision).toBe(1);
    await expect(service.appendTransaction(actor, { ...command, quantity: "3" })).rejects.toMatchObject({ status: 409 });
    expect((await service.getLedgerRevision(actor)).revision).toBe(1);
    await expect(service.appendTransaction(actor, sellCommand({ quantity: "99" }))).rejects.toMatchObject({ status: 400 });
    expect((await service.getLedgerRevision(actor)).revision).toBe(1);
    const sale = await service.appendTransaction(actor, sellCommand({ quantity: "1" }));
    expect((await service.getLedgerRevision(actor)).revision).toBe(2);
    await service.voidTransaction(actor, sale.entry.id, "test");
    expect((await service.getLedgerRevision(actor)).revision).toBe(3);
    expect(await service.voidAllTransactions(actor)).toBe(1);
    expect((await service.getLedgerRevision(actor)).revision).toBe(4);
    expect(await service.voidAllTransactions(actor)).toBe(0);
    expect((await service.getLedgerRevision(actor)).revision).toBe(4);
  });

  it("replace replay yanıtı ilk yanıtla aynı biçimdedir; sürüm bir kez artar", async () => {
    const actor = userActor(user);
    const created = await service.appendTransaction(actor, buyCommand({ quantity: "2" }));
    const replacement = buyCommand({ productId: "has-altin", quantity: "1", clientRequestId: "req-rep-000001" });
    const first = await service.replaceTransaction(actor, created.entry.id, replacement);
    const revisionAfter = (await service.getLedgerRevision(actor)).revision;
    const again = await service.replaceTransaction(actor, created.entry.id, replacement);
    expect(first.positions.map((position) => position.productId)).toEqual(["gram-altin", "has-altin"]);
    expect(again.positions.map((position) => position.productId)).toEqual(["gram-altin", "has-altin"]);
    expect(again.entry.id).toBe(first.entry.id);
    expect((await service.getLedgerRevision(actor)).revision).toBe(revisionAfter);
    await expect(
      backend.replaceLedgerEntry(scopeOf(user), created.entry.id, {
        ...(await (async () => {
          const parsed = parseLedgerCommand({ ...replacement, quantity: "2" });
          if (!parsed.ok) throw new Error("parse");
          return parsed.request;
        })()),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("geçersiz kimlik biçimi 404 döner (kontrolsüz cast yok)", async () => {
    const actor = userActor(user);
    await expect(service.voidTransaction(actor, "not-a-uuid", "x")).rejects.toMatchObject({ status: 404 });
    await expect(service.replaceTransaction(actor, "1' or 1=1", buyCommand())).rejects.toMatchObject({ status: 404 });
  });
});

describe("5. sayısal sınırlar veritabanıyla uyumlu", () => {
  it("çok küçük miktar + büyük tutar → efektif birim değer sınırı aşar → reddedilir", () => {
    expect(() =>
      resolveLedgerAmounts({
        kind: "BUY",
        quantity: "0.000001",
        pricingInputMode: "TOTAL_AMOUNT",
        unitPrice: null,
        totalAmount: "999999999999",
        fees: "0",
        workmanship: "0",
        baselineSnapshot: null,
      }),
    ).toThrow(/çok büyük/);
    expect(() =>
      resolveLedgerAmounts({
        kind: "SELL",
        quantity: "0.000001",
        pricingInputMode: "TOTAL_AMOUNT",
        unitPrice: null,
        totalAmount: "500000000000",
        fees: "0",
        workmanship: "0",
        baselineSnapshot: null,
      }),
    ).toThrow(/çok büyük/);
    // Brüt tutar taşması: 12 basamaklı miktar × 12 basamaklı fiyat
    expect(() =>
      resolveLedgerAmounts({
        kind: "BUY",
        quantity: "999999999999",
        pricingInputMode: "UNIT_PRICE",
        unitPrice: "999999999999",
        totalAmount: null,
        fees: "0",
        workmanship: "0",
        baselineSnapshot: null,
      }),
    ).toThrow(/çok büyük/);
    const command = parseLedgerCommand(buyCommand({ quantity: "0.000001", pricingInputMode: "TOTAL_AMOUNT", totalPaid: "999999999999", unitPrice: undefined }), { now: new Date(NOW) });
    expect(command.ok).toBe(true);
    if (command.ok) expect(() => resolveLedgerAmounts(command.request)).toThrow(/çok büyük/);
  });

  it("özellik: kabul edilen her kombinasyonda tutar ve birim değerler 12 tam basamağı aşmaz (numeric(20,8) sığar)", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const digits = (max: number) => String(Math.max(1, Math.floor(random() * 10 ** Math.floor(random() * max))));
    let accepted = 0;
    for (let index = 0; index < 400; index += 1) {
      const quantity = random() < 0.3 ? `0.${"0".repeat(Math.floor(random() * 5))}1` : digits(12);
      const mode = random() < 0.5 ? "UNIT_PRICE" : "TOTAL_AMOUNT";
      try {
        const amounts = resolveLedgerAmounts({
          kind: random() < 0.7 ? "BUY" : "SELL",
          quantity,
          pricingInputMode: mode,
          unitPrice: mode === "UNIT_PRICE" ? digits(12) : null,
          totalAmount: mode === "TOTAL_AMOUNT" ? digits(12) : null,
          fees: "0",
          workmanship: "0",
          baselineSnapshot: null,
        });
        accepted += 1;
        for (const value of [amounts.grossAmount, amounts.totalPaid, amounts.netProceeds, amounts.effectiveAcquisitionUnitCost, amounts.effectiveNetUnitProceeds]) {
          if (value === null) continue;
          expect(value.split(".")[0]!.length, value).toBeLessThanOrEqual(12);
          expect((value.split(".")[1] ?? "").length, value).toBeLessThanOrEqual(8);
        }
      } catch (error) {
        expect(String(error)).toMatch(/çok büyük|sıfırdan büyük/);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });

  it("birikimli pozisyon maliyeti de sınırı aşamaz (replay guard; TS ve SQL aynı)", () => {
    const first = makeEntry({ quantity: "1", pricingInputMode: "TOTAL_AMOUNT", totalAmount: "600000000000", occurredAt: "2026-01-10" });
    const second = makeEntry({ quantity: "1", pricingInputMode: "TOTAL_AMOUNT", totalAmount: "600000000000", occurredAt: "2026-01-11" });
    expect(() => buildAccountingSummary([first, second], null, NOW)).toThrow(/çok büyük/);
    expect(buildAccountingSummary([first], null, NOW).totalRemainingCostBasis).toBe("600000000000");
  });

  it("migration 0012 aynı sınırı ve sıkı ayrıştırmayı Postgres'te uygular", () => {
    const sql = readFileSync(join("supabase", "migrations", "0012_staging_sync.sql"), "utf8");
    expect(sql).toContain("max_amount constant numeric := 1000000000000");
    expect(sql).toContain("ledger_parse_numeric");
    expect(sql).toContain("ledger_parse_uuid");
    expect(sql).toContain("ledger_bump_revision");
    expect(sql).toContain("guard_portfolio_revision");
    expect(sql).toMatch(/grant execute on function %s to service_role/);
    expect(sql).toContain("'public.ledger_revision(uuid)'");
    expect(sql).not.toMatch(/grant [^\n]*(insert|update|delete)[^\n]*on table/);
  });
});
