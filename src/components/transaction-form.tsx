"use client";

import { useId, useMemo, useState } from "react";

import { getProduct, productsByCategory } from "@/domain/catalog";
import { availableQuantity } from "@/domain/portfolio";
import type { Transaction, TransactionInput } from "@/domain/types";
import {
  todayISO,
  totalFromUnitPrice,
  unitPriceFromTotal,
  validateTransaction,
  type ValidationErrors,
} from "@/domain/validation";
import { formatMoney, formatQuantity, parseDecimal } from "@/lib/format";
import { Alert, Card, Field, cx } from "./ui";

type PriceMode = "unit" | "total";

interface FormState {
  productId: string;
  side: "buy" | "sell";
  quantity: string;
  tradedAt: string;
  priceMode: PriceMode;
  unitPrice: string;
  totalPrice: string;
  fee: string;
  note: string;
}

function initialState(transaction: Transaction | null): FormState {
  if (!transaction) {
    return {
      productId: "gram-altin",
      side: "buy",
      quantity: "",
      tradedAt: todayISO(),
      priceMode: "unit",
      unitPrice: "",
      totalPrice: "",
      fee: "",
      note: "",
    };
  }
  return {
    productId: transaction.productId,
    side: transaction.side,
    quantity: String(transaction.quantity),
    tradedAt: transaction.tradedAt,
    priceMode: "unit",
    unitPrice: String(transaction.unitPrice),
    totalPrice: String(totalFromUnitPrice(transaction.unitPrice, transaction.quantity)),
    fee: transaction.feeAmount ? String(transaction.feeAmount) : "",
    note: transaction.note,
  };
}

export function TransactionForm({
  transactions,
  editing,
  onSubmit,
  onCancel,
}: {
  transactions: readonly Transaction[];
  editing: Transaction | null;
  onSubmit: (input: TransactionInput) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [state, setState] = useState<FormState>(() => initialState(editing));
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const product = getProduct(state.productId);
  const groups = useMemo(() => productsByCategory(), []);

  const quantity = parseDecimal(state.quantity);
  const fee = state.fee.trim() === "" ? 0 : parseDecimal(state.fee);
  const unitPrice =
    state.priceMode === "unit"
      ? parseDecimal(state.unitPrice)
      : unitPriceFromTotal(parseDecimal(state.totalPrice), quantity);

  const available = useMemo(
    () =>
      availableQuantity(transactions, state.productId, {
        excludeTransactionId: editing?.id,
      }),
    [transactions, state.productId, editing?.id],
  );

  const netAmount = useMemo(() => {
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
    const gross = quantity * unitPrice;
    const feeValue = Number.isFinite(fee) ? fee : 0;
    return state.side === "buy" ? gross + feeValue : gross - feeValue;
  }, [quantity, unitPrice, fee, state.side]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((current) => {
      const next = { ...current, [key]: value };
      // Ürün değişince birim değişebilir; miktar tam sayı kısıtı yeniden uygulanır.
      if (key === "productId") {
        setErrors({});
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);

    if (!product) {
      setErrors({ productId: "Lütfen listeden bir altın türü seçin." });
      return;
    }

    const input: TransactionInput = {
      productId: state.productId,
      side: state.side,
      quantity,
      unit: product.unit,
      tradedAt: state.tradedAt,
      unitPrice,
      feeAmount: Number.isFinite(fee) ? fee : Number.NaN,
      note: state.note.trim(),
    };

    const result = validateTransaction(input, {
      existingTransactions: transactions,
      editingTransactionId: editing?.id,
    });

    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setBusy(true);
    try {
      await onSubmit(input);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "İşlem kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">
        {editing ? "İşlemi düzenle" : "Altın ekle"}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Alış ve satış işlemlerinizi kaydedin. Toplamlar ortalama maliyet yöntemiyle hesaplanır.
      </p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <Field label="Altın türü" htmlFor={`${formId}-product`} error={errors.productId}>
          <select
            id={`${formId}-product`}
            className="control"
            value={state.productId}
            onChange={(event) => update("productId", event.target.value)}
            aria-invalid={Boolean(errors.productId)}
          >
            {groups.map((group) => (
              <optgroup key={group.category} label={group.label}>
                {group.products.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        <fieldset>
          <legend className="field-label">İşlem türü</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="İşlem türü">
            {(["buy", "sell"] as const).map((side) => (
              <button
                key={side}
                type="button"
                role="radio"
                aria-checked={state.side === side}
                onClick={() => update("side", side)}
                className={cx(
                  "rounded-[var(--radius-sm)] border px-3 py-2.5 text-sm font-semibold transition-colors",
                  state.side === side
                    ? "border-accent-line bg-accent-soft text-accent"
                    : "border-line-strong bg-surface text-muted hover:bg-surface-3",
                )}
              >
                {side === "buy" ? "Alış" : "Satış"}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={`Miktar (${product?.unit ?? "gram"})`}
            htmlFor={`${formId}-quantity`}
            error={errors.quantity}
            hint={
              state.side === "sell"
                ? `Elinizde ${formatQuantity(available, product?.unit ?? "gram")} var.`
                : product?.unit === "adet"
                  ? "Adet ile takip edilen üründe tam sayı girin."
                  : "Gram cinsinden girin (ondalık kullanabilirsiniz)."
            }
          >
            <input
              id={`${formId}-quantity`}
              className="control tabular"
              inputMode="decimal"
              autoComplete="off"
              placeholder={product?.unit === "adet" ? "1" : "10,5"}
              value={state.quantity}
              onChange={(event) => update("quantity", event.target.value)}
              aria-invalid={Boolean(errors.quantity)}
            />
          </Field>

          <Field label="İşlem tarihi" htmlFor={`${formId}-date`} error={errors.tradedAt}>
            <input
              id={`${formId}-date`}
              type="date"
              className="control tabular"
              max={todayISO()}
              value={state.tradedAt}
              onChange={(event) => update("tradedAt", event.target.value)}
              aria-invalid={Boolean(errors.tradedAt)}
            />
          </Field>
        </div>

        <fieldset>
          <legend className="field-label">Fiyat girişi</legend>
          <div className="mb-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Fiyat girişi">
            {(
              [
                ["unit", "Birim fiyat"],
                ["total", "Toplam tutar"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={state.priceMode === mode}
                onClick={() => update("priceMode", mode)}
                className={cx(
                  "rounded-[var(--radius-sm)] border px-3 py-2 text-[0.8125rem] font-semibold transition-colors",
                  state.priceMode === mode
                    ? "border-line-strong bg-surface-3 text-ink"
                    : "border-line bg-surface text-muted hover:bg-surface-3",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {state.priceMode === "unit" ? (
            <Field
              label={`Birim ${state.side === "buy" ? "alış" : "satış"} fiyatı (TL)`}
              htmlFor={`${formId}-unit-price`}
              error={errors.unitPrice}
            >
              <input
                id={`${formId}-unit-price`}
                className="control tabular"
                inputMode="decimal"
                autoComplete="off"
                placeholder="5.400,00"
                value={state.unitPrice}
                onChange={(event) => update("unitPrice", event.target.value)}
                aria-invalid={Boolean(errors.unitPrice)}
              />
            </Field>
          ) : (
            <Field
              label="Toplam tutar (TL, işçilik hariç)"
              htmlFor={`${formId}-total-price`}
              error={errors.unitPrice}
              hint={
                Number.isFinite(unitPrice) && unitPrice > 0
                  ? `Birim fiyat: ${formatMoney(unitPrice)}`
                  : "Toplam tutardan birim fiyat otomatik hesaplanır."
              }
            >
              <input
                id={`${formId}-total-price`}
                className="control tabular"
                inputMode="decimal"
                autoComplete="off"
                placeholder="54.000,00"
                value={state.totalPrice}
                onChange={(event) => update("totalPrice", event.target.value)}
                aria-invalid={Boolean(errors.unitPrice)}
              />
            </Field>
          )}
        </fieldset>

        <Field
          label="İşçilik / komisyon (TL)"
          htmlFor={`${formId}-fee`}
          error={errors.feeAmount}
          hint="İsteğe bağlı. Alışta maliyete eklenir, satışta gelirden düşülür."
        >
          <input
            id={`${formId}-fee`}
            className="control tabular"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={state.fee}
            onChange={(event) => update("fee", event.target.value)}
            aria-invalid={Boolean(errors.feeAmount)}
          />
        </Field>

        <Field label="Not" htmlFor={`${formId}-note`} error={errors.note} hint="İsteğe bağlı.">
          <textarea
            id={`${formId}-note`}
            className="control resize-y"
            rows={2}
            maxLength={280}
            placeholder="Örn. kuyumcu adı, hediye, birikim"
            value={state.note}
            onChange={(event) => update("note", event.target.value)}
          />
        </Field>

        {netAmount !== null && Number.isFinite(netAmount) && netAmount > 0 ? (
          <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3.5 py-3">
            <p className="text-xs text-subtle">
              {state.side === "buy" ? "Toplam maliyet" : "Net gelir"}
            </p>
            <p className="tabular mt-0.5 text-lg font-semibold text-ink">{formatMoney(netAmount)}</p>
          </div>
        ) : null}

        {submitError ? <Alert tone="danger">{submitError}</Alert> : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Kaydediliyor…" : editing ? "Değişiklikleri kaydet" : "İşlemi kaydet"}
          </button>
        </div>
      </form>
    </Card>
  );
}
