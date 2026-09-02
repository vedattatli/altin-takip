import { getProduct } from "./catalog";
import { availableQuantity } from "./portfolio";
import type { Transaction, TransactionInput } from "./types";

/** Alan bazlı doğrulama sonucu. Anahtar = form alanı adı, değer = Türkçe hata mesajı. */
export type ValidationErrors = Partial<Record<keyof TransactionInput | "form", string>>;

export interface ValidationResult {
  ok: boolean;
  errors: ValidationErrors;
}

/** Miktar için en küçük anlamlı değer (miligram hassasiyeti). */
export const MIN_QUANTITY = 0.001;
/** Tutar alanlarında kabul edilen üst sınır — hatalı girişleri erken yakalar. */
export const MAX_AMOUNT = 1_000_000_000;

export function todayISO(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface ValidateOptions {
  /** Mevcut işlemler — satışın eldeki miktarı aşıp aşmadığını kontrol etmek için. */
  existingTransactions?: readonly Transaction[];
  /** Düzenleme modunda, güncellenen kaydın kendisi hesaptan çıkarılır. */
  editingTransactionId?: string;
  /** Testlerde sabitlenebilmesi için "bugün". */
  now?: Date;
}

export function validateTransaction(
  input: TransactionInput,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: ValidationErrors = {};
  const product = getProduct(input.productId);

  if (!product) {
    errors.productId = "Lütfen listeden bir altın türü seçin.";
  }

  if (input.side !== "buy" && input.side !== "sell") {
    errors.side = "İşlem türü alış veya satış olmalıdır.";
  }

  if (!isFiniteNumber(input.quantity)) {
    errors.quantity = "Miktar sayı olmalıdır.";
  } else if (input.quantity <= 0) {
    errors.quantity = "Miktar sıfırdan büyük olmalıdır.";
  } else if (input.quantity < MIN_QUANTITY) {
    errors.quantity = `Miktar en az ${MIN_QUANTITY} olmalıdır.`;
  } else if (input.quantity > MAX_AMOUNT) {
    errors.quantity = "Miktar beklenenden çok büyük. Lütfen kontrol edin.";
  } else if (product && product.unit === "adet" && !Number.isInteger(input.quantity)) {
    errors.quantity = "Adet ile takip edilen ürünlerde miktar tam sayı olmalıdır.";
  }

  if (product && input.unit !== product.unit) {
    errors.unit = `${product.name} için birim "${product.unit}" olmalıdır.`;
  }

  if (!isFiniteNumber(input.unitPrice)) {
    errors.unitPrice = "Birim fiyat sayı olmalıdır.";
  } else if (input.unitPrice <= 0) {
    errors.unitPrice = "Birim fiyat sıfırdan büyük olmalıdır.";
  } else if (input.unitPrice > MAX_AMOUNT) {
    errors.unitPrice = "Birim fiyat beklenenden çok büyük. Lütfen kontrol edin.";
  }

  if (!isFiniteNumber(input.feeAmount)) {
    errors.feeAmount = "İşçilik/komisyon sayı olmalıdır.";
  } else if (input.feeAmount < 0) {
    errors.feeAmount = "İşçilik/komisyon negatif olamaz.";
  } else if (input.feeAmount > MAX_AMOUNT) {
    errors.feeAmount = "İşçilik/komisyon beklenenden çok büyük. Lütfen kontrol edin.";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradedAt)) {
    errors.tradedAt = "Geçerli bir işlem tarihi seçin.";
  } else if (Number.isNaN(Date.parse(input.tradedAt))) {
    errors.tradedAt = "Geçerli bir işlem tarihi seçin.";
  } else if (input.tradedAt > todayISO(options.now)) {
    errors.tradedAt = "İşlem tarihi gelecekte olamaz.";
  }

  if (input.note.length > 280) {
    errors.note = "Not en fazla 280 karakter olabilir.";
  }

  // Satış miktarı eldeki miktarı aşamaz.
  if (
    product &&
    input.side === "sell" &&
    isFiniteNumber(input.quantity) &&
    input.quantity > 0 &&
    !errors.quantity &&
    options.existingTransactions
  ) {
    const available = availableQuantity(options.existingTransactions, input.productId, {
      excludeTransactionId: options.editingTransactionId,
    });
    if (input.quantity > available + 1e-9) {
      errors.quantity =
        available <= 0
          ? `Elinizde satılabilir ${product.name} bulunmuyor.`
          : `Satış miktarı elinizdeki miktarı aşamaz. Mevcut: ${available} ${product.unit}.`;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Kullanıcı ister birim fiyat, ister toplam tutar girebilir.
 * Toplam tutar girildiğinde birim fiyat buradan türetilir (işçilik hariç).
 */
export function unitPriceFromTotal(total: number, quantity: number): number {
  if (!isFiniteNumber(total) || !isFiniteNumber(quantity) || quantity <= 0) return 0;
  return Math.round((total / quantity) * 100) / 100;
}

export function totalFromUnitPrice(unitPrice: number, quantity: number): number {
  if (!isFiniteNumber(unitPrice) || !isFiniteNumber(quantity)) return 0;
  return Math.round(unitPrice * quantity * 100) / 100;
}
