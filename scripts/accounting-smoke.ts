/**
 * Supabase arka ucu için muhasebe duman testi (YALNIZCA yerel yığın).
 *
 *   npm run accounting:smoke
 *
 * Gerçek SupabaseAuthBackend ile: kullanıcı oluşturur, defter RPC'leri üzerinden
 * kabul örneklerini (1, 4, 8, 9) yürütür, sonuçları doğrular, kullanıcıyı siler.
 * Uzak projelere karşı ÇALIŞMAZ: URL 127.0.0.1 / localhost değilse durur.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { parseLedgerCommand, type LedgerAppendRequest } from "../src/domain/accounting";
import { createUserActor, ownScope } from "../src/server/auth/actor";
import { LedgerAmountError } from "../src/domain/accounting/amounts";
import { IdempotencyConflictError, OversellError } from "../src/server/auth/backend";

function requestOf(command: Parameters<typeof parseLedgerCommand>[0]): LedgerAppendRequest {
  const parsed = parseLedgerCommand(command);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.request;
}

function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` -> ${detail}`}`);
  return ok;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
    console.error("ATLANDI: bu duman testi yalnızca yerel Supabase yığınına karşı çalışır.");
    process.exit(2);
  }
  const { SupabaseAuthBackend } = await import("../src/server/auth/supabase-backend");
  const backend = new SupabaseAuthBackend();
  await backend.ensureReady();

  const username = `smoke${Date.now().toString(36)}`;
  const profile = await backend.createUser({
    username,
    displayName: "Muhasebe Duman Testi",
    temporaryPassword: "Duman7Testi!Kasa",
    role: "user",
  });
  const scope = ownScope(createUserActor(profile, "smoke"));
  let failures = 0;
  const pass = (label: string, ok: boolean, detail?: string) => {
    if (!check(label, ok, detail)) failures += 1;
  };

  try {
    console.log(`Kullanıcı: ${username}`);
    const buy = (occurredAt: string, quantity: string, unitPrice: string) =>
      backend.appendLedgerEntry(scope, requestOf({ kind: "BUY", productId: "gram-altin", quantity, occurredAt, pricingInputMode: "UNIT_PRICE", unitPrice }));

    await buy("2026-01-10", "5", "3500");
    await buy("2026-01-11", "5", "4200");
    const third = await buy("2026-01-12", "5", "3700");
    pass("ÖRNEK 1: 15 gram / 57.000 / 3.800", third.position.quantity === "15" && third.position.remainingCostBasis === "57000" && third.position.averageCost === "3800", JSON.stringify(third.position));
    pass("Girilen birim fiyat korunur (3.700), efektif = total/miktar", third.entry.quotedAcquisitionUnitPrice === "3700" && third.entry.effectiveAcquisitionUnitCost === "3700" && third.entry.occurredAtInstant === "2026-01-11T21:00:00.000Z" && third.entry.occurredTime === null, JSON.stringify(third.entry));

    const withFees = await backend.appendLedgerEntry(scope, requestOf({ kind: "BUY", productId: "has-altin", quantity: "10", occurredAt: "2026-01-15", occurredTime: "14:30", pricingInputMode: "UNIT_PRICE", unitPrice: "5000", fees: "100", workmanship: "500" }));
    pass("Masraflı alış: quoted 5.000 / efektif 5.060 / saat 14:30", withFees.entry.quotedAcquisitionUnitPrice === "5000" && withFees.entry.effectiveAcquisitionUnitCost === "5060" && withFees.entry.totalPaid === "50600" && withFees.entry.occurredTime === "14:30" && withFees.entry.occurredAtInstant === "2026-01-15T11:30:00.000Z", JSON.stringify(withFees.entry));

    let badDate = false;
    try {
      await backend.appendLedgerEntry(scope, { ...requestOf({ kind: "BUY", productId: "has-altin", quantity: "1", occurredAt: "2026-02-01", pricingInputMode: "UNIT_PRICE", unitPrice: "5000" }), occurredAt: "2026-02-30" });
    } catch (error) {
      badDate = error instanceof LedgerAmountError;
    }
    pass("Takvimde olmayan tarih (2026-02-30) RPC'de açık hatayla reddedilir", badDate);

    const sale = await backend.appendLedgerEntry(scope, requestOf({ kind: "SELL", productId: "gram-altin", quantity: "4", occurredAt: "2026-02-01", pricingInputMode: "UNIT_PRICE", unitPrice: "4200" }));
    pass("ÖRNEK 4: net 16.800, gerçekleşmiş 1.600, kalan 11 / 41.800 / 3.800", sale.entry.netProceeds === "16800" && sale.position.realizedPnl === "1600" && sale.position.quantity === "11" && sale.position.remainingCostBasis === "41800" && sale.position.averageCost === "3800", JSON.stringify(sale.position));

    let oversell = false;
    try {
      await backend.appendLedgerEntry(scope, requestOf({ kind: "SELL", productId: "gram-altin", quantity: "20", occurredAt: "2026-02-02", pricingInputMode: "UNIT_PRICE", unitPrice: "4200" }));
    } catch (error) {
      oversell = error instanceof OversellError;
    }
    pass("Aşırı satış OversellError ile reddedilir", oversell);

    const idem = requestOf({ kind: "BUY", productId: "gram-altin", quantity: "1", occurredAt: "2026-02-03", pricingInputMode: "UNIT_PRICE", unitPrice: "5000", clientRequestId: "req-smoke-000001" });
    const first = await backend.appendLedgerEntry(scope, idem);
    const second = await backend.appendLedgerEntry(scope, idem);
    pass("ÖRNEK 8: aynı istek kimliği replay döner, tek kayıt", second.replayed && second.entry.id === first.entry.id);
    let conflict = false;
    try {
      await backend.appendLedgerEntry(scope, requestOf({ ...idem, quantity: "2" }));
    } catch (error) {
      conflict = error instanceof IdempotencyConflictError;
    }
    pass("ÖRNEK 8: farklı içerik conflict", conflict);

    const voided = await backend.voidLedgerEntry(scope, first.entry.id, "duman");
    pass("VOID: kayıt silinmez, durum VOID, pozisyon 11", voided.entry.status === "VOID" && voided.position.quantity === "11");

    const replaced = await backend.replaceLedgerEntry(scope, sale.entry.id, requestOf({ kind: "SELL", productId: "gram-altin", quantity: "3", occurredAt: "2026-02-01", pricingInputMode: "UNIT_PRICE", unitPrice: "4200" }));
    pass("REPLACE: eski REPLACED, yeni bağlı, pozisyon 12", replaced.voided.status === "REPLACED" && replaced.entry.replacesTransactionId === sale.entry.id && replaced.positions[0]?.quantity === "12");

    // MARKET_BASELINE sunucu servisinden geçer: fiyat anlık görüntüsünü servis alır, istemci fiyat gönderemez.
    const { UserPortfolioService } = await import("../src/server/portfolio/user-portfolio-service");
    const service = new UserPortfolioService(backend);
    const baseline = await service.appendTransaction(createUserActor(profile, "smoke"), {
      kind: "OPENING_BALANCE",
      productId: "yeni-ceyrek",
      quantity: "2",
      occurredAt: "2026-02-05",
      costMethod: "MARKET_BASELINE",
      liquidationPrice: "1",
    });
    pass(
      "MARKET_BASELINE: sunucu anlık görüntüsü saklanır, istemci fiyatı yok sayılır",
      baseline.entry.costBasisOrigin === "MARKET_BASELINE" &&
        Boolean(baseline.entry.priceSnapshot?.id) &&
        baseline.entry.priceSnapshot?.liquidationPrice !== "1",
      JSON.stringify(baseline.entry.priceSnapshot),
    );

    // Aynı gün gerçek sıra: 10:00 alış + 11:00 satış geçer; 10:00 satış + 11:00 alış oversell.
    await backend.appendLedgerEntry(scope, requestOf({ kind: "BUY", productId: "kulce-24-ayar", quantity: "2", occurredAt: "2026-02-10", occurredTime: "10:00", pricingInputMode: "UNIT_PRICE", unitPrice: "5000" }));
    const sameDaySell = await backend.appendLedgerEntry(scope, requestOf({ kind: "SELL", productId: "kulce-24-ayar", quantity: "2", occurredAt: "2026-02-10", occurredTime: "11:00", pricingInputMode: "UNIT_PRICE", unitPrice: "5100" }));
    pass("Aynı gün 10:00 alış / 11:00 satış geçer; pozisyon 0, holding kökeni yok, realized köken ACTUAL", sameDaySell.position.quantity === "0" && !sameDaySell.position.holdingCostOrigins.actual && sameDaySell.position.realizedPnlOrigins.actual, JSON.stringify(sameDaySell.position));
    let sameDayOversell = false;
    try {
      await backend.appendLedgerEntry(scope, requestOf({ kind: "SELL", productId: "kulce-24-ayar", quantity: "1", occurredAt: "2026-02-10", occurredTime: "09:00", pricingInputMode: "UNIT_PRICE", unitPrice: "5100" }));
    } catch (error) {
      sameDayOversell = error instanceof OversellError;
    }
    pass("Aynı gün alıştan ÖNCEKİ saate satış oversell ile reddedilir", sameDayOversell);

    // Baseline → tam satış → ACTUAL alış: elde kalan kalite ACTUAL, tarihsel köken korunur.
    const reopened = await backend.appendLedgerEntry(scope, requestOf({ kind: "SELL", productId: "yeni-ceyrek", quantity: "2", occurredAt: "2026-02-06", pricingInputMode: "UNIT_PRICE", unitPrice: "12000" }));
    pass("Baseline pozisyon tam satılınca holding kökeni sıfırlanır, realized baseline korunur", reopened.position.quantity === "0" && !reopened.position.holdingCostOrigins.baseline && reopened.position.realizedPnlOrigins.baseline, JSON.stringify(reopened.position));
    const actualAgain = await backend.appendLedgerEntry(scope, requestOf({ kind: "BUY", productId: "yeni-ceyrek", quantity: "1", occurredAt: "2026-02-07", pricingInputMode: "UNIT_PRICE", unitPrice: "12100" }));
    pass("ACTUAL alışla yeniden açılan pozisyon yalnızca ACTUAL kökenlidir", actualAgain.position.holdingCostOrigins.actual && !actualAgain.position.holdingCostOrigins.baseline && actualAgain.position.realizedPnlOrigins.baseline, JSON.stringify(actualAgain.position));

    const verify = await backend.verifyLedger(scope);
    pass("ledger_verify: tutarsızlık yok", verify.mismatches.length === 0 && verify.checked >= 2, JSON.stringify(verify));
    const ledger = await backend.listLedger(scope);
    pass("ledger_list: VOID ve REPLACED kayıtlar dâhil", ledger.some((entry) => entry.status === "VOID") && ledger.some((entry) => entry.status === "REPLACED"));
    pass("sayılar ondalık metin", ledger.every((entry) => typeof entry.quantity === "string" && !/e/i.test(entry.quantity)));
  } finally {
    await backend.deleteUser(profile.id);
  }

  console.log("");
  console.log(failures === 0 ? "Supabase muhasebe duman testi geçti." : `${failures} kontrol başarısız.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Duman testi çalıştırılamadı.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
