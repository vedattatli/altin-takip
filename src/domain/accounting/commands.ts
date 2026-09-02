import { getProduct } from "@/domain/catalog";
import type { GoldProduct } from "@/domain/types";
import { dec, parseDecimalInput, QUANTITY_SCALE, toDecimalString } from "./decimal";
import { validatePriceSnapshotInput } from "./snapshot";
import {
  isValidCalendarDate,
  isValidTimeOfDay,
  OCCURRED_AT_FUTURE_TOLERANCE_MS,
  occurredAtInstantISO,
  todayISO,
  zonedToInstantMs,
} from "./time";
import type { LedgerAppendRequest, LedgerCommand, PriceSnapshotInput } from "./types";

/**
 * Komut doğrulama — istemciden gelen gövde SIKI biçimde denetlenir.
 *
 * - Ürün katalogdan; birim istemciden ALINMAZ.
 * - Miktar: gram üründe en fazla 6 ondalık, adet üründe yalnızca pozitif tam sayı.
 * - Tutarlar: pozitif ondalık dize; NaN/Infinity/bilimsel gösterim/aşırı büyük değer/
 *   iç boşluk/belirsiz ayırıcı reddedilir.
 * - Tarih: gerçek takvim tarihi (YYYY-MM-DD, Europe/Istanbul); isteğe bağlı saat HH:MM;
 *   gelecekte olamaz (5 dakika tolerans).
 * - MARKET_BASELINE anlık görüntüsü sunucudan gelir ve ayrıca doğrulanır.
 * Aynı doğrulama istemcide (form) ve sunucuda (servis) çalışır.
 */

export type CommandErrors = Partial<
  Record<
    | "kind"
    | "productId"
    | "quantity"
    | "occurredAt"
    | "occurredTime"
    | "unitPrice"
    | "totalPaid"
    | "netProceeds"
    | "fees"
    | "workmanship"
    | "costAmount"
    | "costMethod"
    | "note"
    | "form",
    string
  >
>;

export type CommandParseResult =
  | { ok: true; request: LedgerAppendRequest; product: GoldProduct }
  | { ok: false; errors: CommandErrors };

const MONEY_INPUT_SCALE = 4;
const NOTE_MAX = 280;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;

function parseMoney(
  raw: unknown,
  errors: CommandErrors,
  field: keyof CommandErrors,
  options: { allowZero: boolean; required: boolean },
): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) errors[field] = "Bu alan zorunludur.";
    return options.required ? null : "0";
  }
  const parsed = parseDecimalInput(raw, { maxScale: MONEY_INPUT_SCALE, allowZero: options.allowZero });
  if (!parsed.ok) {
    errors[field] = parsed.error;
    return null;
  }
  return toDecimalString(parsed.value);
}

interface ParsedWhen {
  occurredAt: string;
  occurredTime: string | null;
  occurredAtInstant: string;
}

/**
 * Tarih + isteğe bağlı saat. Gerçek takvim tarihi olmayan değer (2026-02-30) reddedilir;
 * artık yıl doğru uygulanır (2028-02-29 kabul). Gelecek tarih/saat reddedilir.
 */
function parseWhen(
  rawDate: unknown,
  rawTime: unknown,
  errors: CommandErrors,
  now: Date,
  options: { defaultToday: boolean },
): ParsedWhen {
  const empty: ParsedWhen = { occurredAt: "", occurredTime: null, occurredAtInstant: "" };
  let date: string;
  if (rawDate === undefined || rawDate === null || rawDate === "") {
    if (!options.defaultToday) {
      errors.occurredAt = "Geçerli bir işlem tarihi seçin.";
      return empty;
    }
    date = todayISO(now);
  } else if (!isValidCalendarDate(rawDate)) {
    errors.occurredAt = "Geçerli bir işlem tarihi seçin (takvimde olmayan gün girilemez).";
    return empty;
  } else {
    date = rawDate;
  }

  let time: string | null = null;
  if (rawTime !== undefined && rawTime !== null && rawTime !== "") {
    if (!isValidTimeOfDay(rawTime)) {
      errors.occurredTime = "Saat SS:DD biçiminde olmalıdır (örn. 14:30).";
      return empty;
    }
    time = rawTime;
  }

  if (date > todayISO(now)) {
    errors.occurredAt = "İşlem tarihi gelecekte olamaz.";
    return empty;
  }
  const instant = zonedToInstantMs(date, time);
  if (instant === null) {
    errors.occurredAt = "Geçerli bir işlem tarihi seçin.";
    return empty;
  }
  if (instant > now.getTime() + OCCURRED_AT_FUTURE_TOLERANCE_MS) {
    errors[time ? "occurredTime" : "occurredAt"] = "İşlem zamanı gelecekte olamaz.";
    return empty;
  }
  return { occurredAt: date, occurredTime: time, occurredAtInstant: occurredAtInstantISO(date, time) ?? "" };
}

function parseNote(raw: unknown, errors: CommandErrors): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return "";
  if (raw.length > NOTE_MAX) {
    errors.note = `Not en fazla ${NOTE_MAX} karakter olabilir.`;
    return raw.slice(0, NOTE_MAX);
  }
  return raw.trim();
}

function parseClientRequestId(raw: unknown, errors: CommandErrors): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !CLIENT_REQUEST_ID.test(raw)) {
    errors.form = "İstek kimliği geçersiz.";
    return null;
  }
  return raw;
}

export function parseQuantity(raw: unknown, product: GoldProduct, errors: CommandErrors): string {
  const parsed = parseDecimalInput(raw, {
    maxScale: product.unit === "adet" ? 0 : QUANTITY_SCALE,
    allowZero: false,
  });
  if (!parsed.ok) {
    errors.quantity =
      product.unit === "adet" && parsed.error.includes("tam sayı")
        ? "Adet ile takip edilen ürünlerde miktar pozitif tam sayı olmalıdır."
        : parsed.error === "Geçerli bir sayı girin."
          ? "Miktar için geçerli bir sayı girin."
          : parsed.error.replace("Değer", "Miktar");
    return "";
  }
  return toDecimalString(parsed.value);
}

/**
 * Komutu doğrular ve arka uç isteğine çevirir.
 * MARKET_BASELINE için sunucu `baselineSnapshot` sağlar; istemciden fiyat KABUL EDİLMEZ.
 */
export function parseLedgerCommand(
  raw: unknown,
  options: { now?: Date; baselineSnapshot?: PriceSnapshotInput | null } = {},
): CommandParseResult {
  const errors: CommandErrors = {};
  const now = options.now ?? new Date();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: { form: "Geçersiz işlem verisi." } };
  }
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  if (kind !== "OPENING_BALANCE" && kind !== "BUY" && kind !== "SELL") {
    return { ok: false, errors: { kind: "İşlem türü mevcut altın, alış veya satış olmalıdır." } };
  }

  const productId = typeof body.productId === "string" ? body.productId : "";
  const product = getProduct(productId);
  if (!product) {
    return { ok: false, errors: { productId: "Lütfen listeden geçerli bir altın türü seçin." } };
  }

  const quantity = parseQuantity(body.quantity, product, errors);
  const note = parseNote(body.note, errors);
  const clientRequestId = parseClientRequestId(body.clientRequestId, errors);

  if (kind === "OPENING_BALANCE") {
    const when = parseWhen(body.occurredAt, body.occurredTime, errors, now, { defaultToday: true });
    const method = body.costMethod;
    if (method !== "ACTUAL" && method !== "ESTIMATED" && method !== "MARKET_BASELINE") {
      errors.costMethod = "Maliyet yöntemi seçin.";
      return { ok: false, errors };
    }

    if (method === "MARKET_BASELINE") {
      if (!options.baselineSnapshot) {
        errors.form = "Güncel fiyat alınamadığı için takip başlangıcı oluşturulamadı.";
      } else {
        const snapshotError = validatePriceSnapshotInput(options.baselineSnapshot, productId, now.getTime());
        if (snapshotError) errors.form = snapshotError;
      }
      if (Object.keys(errors).length > 0) return { ok: false, errors };
      return {
        ok: true,
        product,
        request: {
          kind,
          productId,
          quantity,
          unit: product.unit,
          ...when,
          pricingInputMode: "MARKET_BASELINE",
          unitPrice: null,
          totalAmount: null,
          fees: "0",
          workmanship: "0",
          costBasisOrigin: "MARKET_BASELINE",
          note,
          clientRequestId,
          baselineSnapshot: options.baselineSnapshot ?? null,
        },
      };
    }

    const inputMode = body.costInputMode;
    if (inputMode !== "AVERAGE_UNIT_COST" && inputMode !== "TOTAL_COST") {
      errors.costAmount = "Ortalama birim maliyet veya toplam maliyet girin.";
      return { ok: false, errors };
    }
    const amount = parseMoney(body.costAmount, errors, "costAmount", { allowZero: false, required: true });
    if (Object.keys(errors).length > 0 || amount === null) return { ok: false, errors };

    return {
      ok: true,
      product,
      request: {
        kind,
        productId,
        quantity,
        unit: product.unit,
        ...when,
        pricingInputMode: inputMode === "AVERAGE_UNIT_COST" ? "UNIT_PRICE" : "TOTAL_AMOUNT",
        unitPrice: inputMode === "AVERAGE_UNIT_COST" ? amount : null,
        totalAmount: inputMode === "TOTAL_COST" ? amount : null,
        fees: "0",
        workmanship: "0",
        costBasisOrigin: method,
        note,
        clientRequestId,
        baselineSnapshot: null,
      },
    };
  }

  const when = parseWhen(body.occurredAt, body.occurredTime, errors, now, { defaultToday: false });
  const mode = body.pricingInputMode;
  if (mode !== "UNIT_PRICE" && mode !== "TOTAL_AMOUNT") {
    errors.form = "Fiyat giriş yöntemi birim fiyat veya toplam tutar olmalıdır.";
    return { ok: false, errors };
  }
  const fees = parseMoney(body.fees, errors, "fees", { allowZero: true, required: false }) ?? "0";

  if (kind === "BUY") {
    const workmanship =
      parseMoney(body.workmanship, errors, "workmanship", { allowZero: true, required: false }) ?? "0";
    const unitPrice =
      mode === "UNIT_PRICE"
        ? parseMoney(body.unitPrice, errors, "unitPrice", { allowZero: false, required: true })
        : null;
    const totalPaid =
      mode === "TOTAL_AMOUNT"
        ? parseMoney(body.totalPaid, errors, "totalPaid", { allowZero: false, required: true })
        : null;
    if (mode === "TOTAL_AMOUNT" && totalPaid && dec(fees).plus(dec(workmanship)).greaterThan(dec(totalPaid))) {
      errors.totalPaid = "Masraflar toplam ödenen tutarı aşamaz.";
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      product,
      request: {
        kind,
        productId,
        quantity,
        unit: product.unit,
        ...when,
        pricingInputMode: mode,
        unitPrice,
        totalAmount: totalPaid,
        fees,
        workmanship,
        costBasisOrigin: "ACTUAL",
        note,
        clientRequestId,
        baselineSnapshot: null,
      },
    };
  }

  // SELL
  const unitPrice =
    mode === "UNIT_PRICE"
      ? parseMoney(body.unitPrice, errors, "unitPrice", { allowZero: false, required: true })
      : null;
  const netProceeds =
    mode === "TOTAL_AMOUNT"
      ? parseMoney(body.netProceeds, errors, "netProceeds", { allowZero: true, required: true })
      : null;
  if (mode === "UNIT_PRICE" && unitPrice && dec(fees).greaterThan(dec(unitPrice).times(dec(quantity || "0")))) {
    errors.fees = "Satış masrafları satış tutarını aşamaz.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    product,
    request: {
      kind,
      productId,
      quantity,
      unit: product.unit,
      ...when,
      pricingInputMode: mode,
      unitPrice,
      totalAmount: netProceeds,
      fees,
      workmanship: "0",
      costBasisOrigin: "ACTUAL",
      note,
      clientRequestId,
      baselineSnapshot: null,
    },
  };
}

/** Komut nesnesinden (istemci tarafı) doğrudan doğrulama; aynı kuralları uygular. */
export function validateLedgerCommand(command: LedgerCommand, now: Date = new Date()): CommandErrors {
  const nowIso = now.toISOString();
  const result = parseLedgerCommand(command, {
    now,
    // İstemci ön elemesi: piyasa başlangıcı sunucuda oluşturulur; burada yalnızca biçim denetlenir.
    baselineSnapshot:
      command.kind === "OPENING_BALANCE" && command.costMethod === "MARKET_BASELINE"
        ? {
            productId: command.productId,
            liquidationPrice: "1",
            replacementPrice: "1",
            provider: "preview",
            market: "preview",
            currency: "TRY",
            providerStatus: "ok",
            isRealMarketData: false,
            providerTimestamp: nowIso,
            fetchedAt: nowIso,
          }
        : null,
  });
  return result.ok ? {} : result.errors;
}

/** Tarayıcı / Node ortamında idempotency anahtarı üretir. */
export function createClientRequestId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `req-${random}`;
}
