"use client";

import { useId, useMemo, useState, type ReactNode } from "react";

import {
  createClientRequestId,
  dec,
  parseLedgerCommand,
  resolveLedgerAmounts,
  todayISO,
  toDecimalString,
  toInputDecimal,
  type AccountingSummary,
  type BuyCommand,
  type CommandErrors,
  type LedgerCommand,
  type LedgerEntry,
  type OpeningBalanceCommand,
  type OpeningCostInputMode,
  type OpeningCostMethod,
  type SellCommand,
} from "@/domain/accounting";
import { getProduct, GOLD_PRODUCTS } from "@/domain/catalog";
import type { GoldProduct } from "@/domain/types";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/format";
import type { PriceQuote } from "@/prices/types";
import { usableQuoteOrNull } from "@/prices/validate";
import { displayProductName, isPrimaryProduct, PRIMARY_DISPLAY_GROUPS } from "@/prices/valuation-plan";
import { usePortfolio } from "@/state/portfolio-store";
import { marketLabel, useClientClock } from "./price-source-line";
import { Alert, Card, Field, cx } from "./ui";

/**
 * Defter formları: Mevcut Altını Ekle (açılış bakiyesi), Yeni Alış, Satış.
 *
 * - Bütün sayısal alanlar METİN olarak taşınır; istemci Number'a çevirmez.
 * - Aynı form örneği tek bir idempotency anahtarı (clientRequestId) taşır:
 *   çift tıklama veya mobil ağ yeniden denemesi aynı işlemi iki kez oluşturmaz.
 * - Doğrulama istemcide yalnızca kullanıcı deneyimi içindir; sunucu yeniden doğrular.
 */

type PriceMode = "UNIT_PRICE" | "TOTAL_AMOUNT";

function firstErrorText(errors: CommandErrors): string | null {
  return Object.values(errors).find(Boolean) ?? null;
}

/**
 * ALTIN TÜRÜ SEÇİMİ — SADE LİSTE
 *
 * İlk ve varsayılan liste ALTI üründen oluşur. Katalogdaki diğer ürünler
 * silinmez; ama yeni kayıt açarken kalabalık yapmasın diye varsayılan listede
 * görünmezler.
 *
 * İKİ İSTİSNA VARDIR VE ZORUNLUDUR:
 *  1. Kullanıcının ELİNDE olan gizli bir ürün listeye eklenir — yoksa o
 *     varlığı satamaz ve kayıt kilitlenirdi.
 *  2. DÜZELTİLEN kaydın ürünü listeye eklenir — yoksa düzeltme formu ürünü
 *     sessizce başka bir ürüne çevirirdi.
 */
function ProductSelect({
  id,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (productId: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { summary } = usePortfolio();

  const options = useMemo(() => {
    const primary = PRIMARY_DISPLAY_GROUPS.map((group) => ({
      id: group.primaryProductId,
      label: group.label,
    }));

    const heldIds = new Set(
      summary.holdings
        .filter((holding) => dec(holding.position.quantity).greaterThan(0))
        .map((holding) => holding.product.id),
    );
    const extraIds = new Set<string>();
    for (const productId of heldIds) if (!isPrimaryProduct(productId)) extraIds.add(productId);
    if (value !== "" && !isPrimaryProduct(value)) extraIds.add(value);

    const others = GOLD_PRODUCTS.filter((product) => extraIds.has(product.id)).map((product) => ({
      id: product.id,
      label: displayProductName(product.id, product.name, { distinguish: true }),
    }));

    return { primary, others };
  }, [summary.holdings, value]);

  return (
    <Field label="Altın türü" htmlFor={id} error={error}>
      <select
        id={id}
        className="control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        disabled={disabled}
      >
        {options.primary.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {options.others.length > 0 ? (
          <optgroup label="Diğer varlıklarınız">
            {options.others.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </Field>
  );
}

function ModeToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="field-label">{label}</legend>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              "min-h-11 rounded-[var(--radius-sm)] border px-3 py-2 text-[0.8125rem] font-semibold transition-colors",
              value === option.value
                ? "border-accent-line bg-accent-soft text-accent"
                : "border-line bg-surface text-muted hover:bg-surface-3",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function DecimalInput({
  id,
  value,
  onChange,
  placeholder,
  error,
  integer,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  integer?: boolean;
}) {
  return (
    <input
      id={id}
      className="control tabular min-h-11"
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={Boolean(error)}
    />
  );
}

function QuantityField({
  id,
  product,
  value,
  onChange,
  error,
  hint,
}: {
  id: string;
  product: GoldProduct | undefined;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  const unit = product?.unit ?? "gram";
  return (
    <Field
      label={`Miktar (${unit})`}
      htmlFor={id}
      error={error}
      hint={
        hint ??
        (unit === "adet"
          ? "Adet ile takip edilen üründe pozitif tam sayı girin."
          : "Gram cinsinden girin; en fazla 6 ondalık basamak.")
      }
    >
      <DecimalInput
        id={id}
        value={value}
        onChange={onChange}
        placeholder={unit === "adet" ? "1" : "10,5"}
        error={error}
        integer={unit === "adet"}
      />
    </Field>
  );
}

/** Tarih zorunlu, saat isteğe bağlı (aynı gün birden fazla işlemde gerçek sırayı belirler). */
function DateTimeFields({
  formId,
  date,
  time,
  onDate,
  onTime,
  errors,
}: {
  formId: string;
  date: string;
  time: string;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
  errors: CommandErrors;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <Field label="İşlem tarihi" htmlFor={`${formId}-date`} error={errors.occurredAt}>
        <input
          id={`${formId}-date`}
          type="date"
          className="control tabular min-h-11"
          max={todayISO()}
          value={date}
          onChange={(event) => onDate(event.target.value)}
          aria-invalid={Boolean(errors.occurredAt)}
        />
      </Field>
      <Field label="Saat" htmlFor={`${formId}-time`} error={errors.occurredTime} hint="İsteğe bağlı">
        <input
          id={`${formId}-time`}
          type="time"
          className="control tabular min-h-11 w-28"
          value={time}
          onChange={(event) => onTime(event.target.value)}
          aria-invalid={Boolean(errors.occurredTime)}
          data-testid="occurred-time"
        />
      </Field>
    </div>
  );
}

function PreviewBox({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3.5 py-3">
      <p className="text-xs text-subtle">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</p>
      {children}
    </div>
  );
}

function FormActions({
  busy,
  submitLabel,
  onCancel,
  submitTestId,
}: {
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  submitTestId?: string;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" className="btn btn-secondary min-h-11" onClick={onCancel} disabled={busy}>
        Vazgeç
      </button>
      <button type="submit" className="btn btn-primary min-h-11" disabled={busy} data-testid={submitTestId}>
        {busy ? "Kaydediliyor…" : submitLabel}
      </button>
    </div>
  );
}

/** Önizleme: komut geçerliyse hesaplanan tutarlar. */
function previewAmounts(command: LedgerCommand) {
  const parsed = parseLedgerCommand(command, {
    baselineSnapshot:
      command.kind === "OPENING_BALANCE" && command.costMethod === "MARKET_BASELINE"
        ? null
        : undefined,
  });
  if (!parsed.ok) return null;
  try {
    return resolveLedgerAmounts(parsed.request);
  } catch {
    return null;
  }
}

// ================================================================== ALIŞ

interface BuyState {
  productId: string;
  quantity: string;
  occurredAt: string;
  /** İsteğe bağlı saat (HH:MM); aynı gün içindeki sırayı belirler. */
  occurredTime: string;
  mode: PriceMode;
  unitPrice: string;
  totalPaid: string;
  workmanship: string;
  fees: string;
  note: string;
}

function buyInitial(editing: LedgerEntry | null): BuyState {
  if (!editing) {
    return {
      productId: "gram-altin",
      quantity: "",
      occurredAt: todayISO(),
      occurredTime: "",
      mode: "UNIT_PRICE",
      unitPrice: "",
      totalPaid: "",
      workmanship: "",
      fees: "",
      note: "",
    };
  }
  const mode: PriceMode = editing.pricingInputMode === "TOTAL_AMOUNT" ? "TOTAL_AMOUNT" : "UNIT_PRICE";
  const quantity = dec(editing.quantity);
  // Düzeltmede GİRİLEN birim fiyat (masraflar hariç) geri yüklenir; efektif maliyet değil.
  const quoted =
    editing.quotedAcquisitionUnitPrice ??
    (quantity.greaterThan(0) ? toDecimalString(dec(editing.grossAmount).div(quantity)) : "");
  return {
    productId: editing.productId,
    quantity: toInputDecimal(editing.quantity),
    occurredAt: editing.occurredAt,
    occurredTime: editing.occurredTime ?? "",
    mode,
    unitPrice: mode === "UNIT_PRICE" && quoted ? toInputDecimal(quoted) : "",
    totalPaid: mode === "TOTAL_AMOUNT" && editing.totalPaid ? toInputDecimal(editing.totalPaid) : "",
    workmanship: dec(editing.workmanship).isZero() ? "" : toInputDecimal(editing.workmanship),
    fees: dec(editing.fees).isZero() ? "" : toInputDecimal(editing.fees),
    note: editing.note,
  };
}

export function BuyForm({
  editing = null,
  onSubmit,
  onCancel,
}: {
  editing?: LedgerEntry | null;
  onSubmit: (command: BuyCommand) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [clientRequestId] = useState(() => createClientRequestId());
  const [state, setState] = useState<BuyState>(() => buyInitial(editing));
  const [errors, setErrors] = useState<CommandErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const product = getProduct(state.productId);

  const command = useMemo<BuyCommand>(
    () => ({
    kind: "BUY",
    productId: state.productId,
    quantity: state.quantity,
    occurredAt: state.occurredAt,
    occurredTime: state.occurredTime || undefined,
    pricingInputMode: state.mode,
    unitPrice: state.mode === "UNIT_PRICE" ? state.unitPrice : undefined,
    totalPaid: state.mode === "TOTAL_AMOUNT" ? state.totalPaid : undefined,
    workmanship: state.workmanship || undefined,
    fees: state.fees || undefined,
    note: state.note.trim(),
    clientRequestId,
    }),
    [state, clientRequestId],
  );
  const preview = useMemo(() => previewAmounts(command), [command]);

  function update<K extends keyof BuyState>(key: K, value: BuyState[K]) {
    setState((current) => ({ ...current, [key]: value }));
    setErrors({});
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);
    const parsed = parseLedgerCommand(command);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(command);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "İşlem kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">{editing ? "Alışı düzelt" : "Yeni alış ekle"}</h2>
      <p className="mt-1 text-sm text-muted">
        Gerçekten ödediğiniz tutarı girin; piyasa fiyatı yalnızca öneridir ve maliyetinizi değiştirmez.
        {editing ? " Düzeltme eski kaydı iptal edip yerine yeni kayıt oluşturur." : ""}
      </p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <ProductSelect
          id={`${formId}-product`}
          value={state.productId}
          onChange={(value) => update("productId", value)}
          error={errors.productId}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <QuantityField
            id={`${formId}-quantity`}
            product={product}
            value={state.quantity}
            onChange={(value) => update("quantity", value)}
            error={errors.quantity}
          />
          <DateTimeFields
            formId={formId}
            date={state.occurredAt}
            time={state.occurredTime}
            onDate={(value) => update("occurredAt", value)}
            onTime={(value) => update("occurredTime", value)}
            errors={errors}
          />
        </div>

        <ModeToggle
          label="Fiyat giriş yöntemi"
          value={state.mode}
          options={[
            { value: "UNIT_PRICE", label: "Birim fiyat + masraflar" },
            { value: "TOTAL_AMOUNT", label: "Toplam ödenen tutar" },
          ]}
          onChange={(value) => update("mode", value)}
        />

        {state.mode === "UNIT_PRICE" ? (
          <Field
            label="Birim alış fiyatı (TL)"
            htmlFor={`${formId}-unit-price`}
            error={errors.unitPrice}
            hint="Masraflar hariç, gerçekten ödediğiniz birim fiyat. Ondalık için virgül kullanın (5.400,00 veya 5400)."
          >
            <DecimalInput
              id={`${formId}-unit-price`}
              value={state.unitPrice}
              onChange={(value) => update("unitPrice", value)}
              placeholder="5.400,00"
              error={errors.unitPrice}
            />
          </Field>
        ) : (
          <Field
            label="Toplam ödenen tutar (TL, bütün masraflar dâhil)"
            htmlFor={`${formId}-total-paid`}
            error={errors.totalPaid}
            hint="Kuyumcuya gerçekten ödediğiniz toplam. İşçilik ve komisyon bu tutarın İÇİNDEDİR; ikinci kez eklenmez."
          >
            <DecimalInput
              id={`${formId}-total-paid`}
              value={state.totalPaid}
              onChange={(value) => update("totalPaid", value)}
              placeholder="54.600,00"
              error={errors.totalPaid}
            />
          </Field>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="İşçilik (TL)"
            htmlFor={`${formId}-workmanship`}
            error={errors.workmanship}
            hint={
              state.mode === "UNIT_PRICE"
                ? "İsteğe bağlı. Maliyete eklenir."
                : "İsteğe bağlı. Yalnızca bilgi amaçlı ayrıştırma; toplam tutarın içindedir."
            }
          >
            <DecimalInput
              id={`${formId}-workmanship`}
              value={state.workmanship}
              onChange={(value) => update("workmanship", value)}
              placeholder="0"
              error={errors.workmanship}
            />
          </Field>
          <Field
            label="Komisyon / diğer masraf (TL)"
            htmlFor={`${formId}-fees`}
            error={errors.fees}
            hint={state.mode === "UNIT_PRICE" ? "İsteğe bağlı. Maliyete eklenir." : "İsteğe bağlı. Toplam tutarın içindedir."}
          >
            <DecimalInput
              id={`${formId}-fees`}
              value={state.fees}
              onChange={(value) => update("fees", value)}
              placeholder="0"
              error={errors.fees}
            />
          </Field>
        </div>

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

        {preview?.totalPaid ? (
          <PreviewBox label="Toplam edinim maliyeti" value={formatMoney(preview.totalPaid)}>
            <p className="mt-1 text-xs text-muted" data-testid="buy-preview-prices">
              {preview.quotedAcquisitionUnitPrice
                ? `Girilen birim fiyat: ${formatMoney(preview.quotedAcquisitionUnitPrice)} · `
                : ""}
              Masraflar dâhil efektif birim maliyet: {formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}
            </p>
          </PreviewBox>
        ) : null}

        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        {submitError ? <Alert tone="danger">{submitError}</Alert> : null}

        <FormActions
          busy={busy}
          submitLabel={editing ? "Düzeltmeyi kaydet" : "Alışı kaydet"}
          onCancel={onCancel}
          submitTestId="submit-buy"
        />
      </form>
    </Card>
  );
}

// ================================================================== SATIŞ

interface SellState {
  productId: string;
  quantity: string;
  occurredAt: string;
  occurredTime: string;
  mode: PriceMode;
  unitPrice: string;
  netProceeds: string;
  fees: string;
  note: string;
}

function sellInitial(editing: LedgerEntry | null, defaultProductId: string): SellState {
  if (!editing) {
    return {
      productId: defaultProductId,
      quantity: "",
      occurredAt: todayISO(),
      occurredTime: "",
      mode: "UNIT_PRICE",
      unitPrice: "",
      netProceeds: "",
      fees: "",
      note: "",
    };
  }
  const mode: PriceMode = editing.pricingInputMode === "TOTAL_AMOUNT" ? "TOTAL_AMOUNT" : "UNIT_PRICE";
  const quantity = dec(editing.quantity);
  const quoted =
    editing.quotedDisposalUnitPrice ??
    (quantity.greaterThan(0) ? toDecimalString(dec(editing.grossAmount).div(quantity)) : "");
  return {
    productId: editing.productId,
    quantity: toInputDecimal(editing.quantity),
    occurredAt: editing.occurredAt,
    occurredTime: editing.occurredTime ?? "",
    mode,
    unitPrice: mode === "UNIT_PRICE" && quoted ? toInputDecimal(quoted) : "",
    netProceeds: mode === "TOTAL_AMOUNT" && editing.netProceeds ? toInputDecimal(editing.netProceeds) : "",
    fees: dec(editing.fees).isZero() ? "" : toInputDecimal(editing.fees),
    note: editing.note,
  };
}

export function SellForm({
  summary,
  editing = null,
  onSubmit,
  onCancel,
}: {
  summary: AccountingSummary;
  editing?: LedgerEntry | null;
  onSubmit: (command: SellCommand) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [clientRequestId] = useState(() => createClientRequestId());
  const openHoldings = summary.holdings.filter((holding) => dec(holding.position.quantity).greaterThan(0));
  const [state, setState] = useState<SellState>(() =>
    sellInitial(editing, openHoldings[0]?.product.id ?? "gram-altin"),
  );
  const [errors, setErrors] = useState<CommandErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const product = getProduct(state.productId);

  const available = openHoldings.find((holding) => holding.product.id === state.productId)?.position
    .quantity;
  // Düzeltmede düzeltilen satışın miktarı da satılabilir sayılır.
  const availableForSale =
    editing && editing.productId === state.productId
      ? toDecimalString(dec(available ?? "0").plus(dec(editing.quantity)))
      : (available ?? "0");

  const command = useMemo<SellCommand>(
    () => ({
    kind: "SELL",
    productId: state.productId,
    quantity: state.quantity,
    occurredAt: state.occurredAt,
    occurredTime: state.occurredTime || undefined,
    pricingInputMode: state.mode,
    unitPrice: state.mode === "UNIT_PRICE" ? state.unitPrice : undefined,
    netProceeds: state.mode === "TOTAL_AMOUNT" ? state.netProceeds : undefined,
    fees: state.fees || undefined,
    note: state.note.trim(),
    clientRequestId,
    }),
    [state, clientRequestId],
  );
  const preview = useMemo(() => previewAmounts(command), [command]);

  function update<K extends keyof SellState>(key: K, value: SellState[K]) {
    setState((current) => ({ ...current, [key]: value }));
    setErrors({});
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);
    const parsed = parseLedgerCommand(command);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    if (dec(parsed.request.quantity).greaterThan(dec(availableForSale))) {
      setErrors({
        quantity:
          dec(availableForSale).isZero()
            ? `Elinizde satılabilir ${product?.name ?? "ürün"} bulunmuyor.`
            : `Satış miktarı elinizdeki miktarı aşamaz. Mevcut: ${formatQuantity(availableForSale, product?.unit ?? "gram")}.`,
      });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(command);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "İşlem kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">{editing ? "Satışı düzelt" : "Satış ekle"}</h2>
      <p className="mt-1 text-sm text-muted">
        Satış, kalan ürünlerin ortalama maliyetini değiştirmez; gerçekleşmiş kâr/zarar ayrı gösterilir.
      </p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <ProductSelect
          id={`${formId}-product`}
          value={state.productId}
          onChange={(value) => update("productId", value)}
          error={errors.productId}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <QuantityField
            id={`${formId}-quantity`}
            product={product}
            value={state.quantity}
            onChange={(value) => update("quantity", value)}
            error={errors.quantity}
            hint={`Elinizde ${formatQuantity(availableForSale, product?.unit ?? "gram")} var.`}
          />
          <DateTimeFields
            formId={formId}
            date={state.occurredAt}
            time={state.occurredTime}
            onDate={(value) => update("occurredAt", value)}
            onTime={(value) => update("occurredTime", value)}
            errors={errors}
          />
        </div>

        <ModeToggle
          label="Tutar girişi"
          value={state.mode}
          options={[
            { value: "UNIT_PRICE", label: "Birim satış fiyatı" },
            { value: "TOTAL_AMOUNT", label: "Net tahsil edilen tutar" },
          ]}
          onChange={(value) => update("mode", value)}
        />

        {state.mode === "UNIT_PRICE" ? (
          <Field
            label="Birim satış fiyatı (TL)"
            htmlFor={`${formId}-unit-price`}
            error={errors.unitPrice}
            hint="Masraflar düşülmeden önceki brüt birim fiyat."
          >
            <DecimalInput
              id={`${formId}-unit-price`}
              value={state.unitPrice}
              onChange={(value) => update("unitPrice", value)}
              placeholder="5.300,00"
              error={errors.unitPrice}
            />
          </Field>
        ) : (
          <Field
            label="Net tahsil edilen tutar (TL)"
            htmlFor={`${formId}-net`}
            error={errors.netProceeds}
            hint="Masraflar düşüldükten sonra elinize geçen gerçek tutar."
          >
            <DecimalInput
              id={`${formId}-net`}
              value={state.netProceeds}
              onChange={(value) => update("netProceeds", value)}
              placeholder="16.800,00"
              error={errors.netProceeds}
            />
          </Field>
        )}

        <Field
          label="Satış masrafı (TL)"
          htmlFor={`${formId}-fees`}
          error={errors.fees}
          hint={state.mode === "UNIT_PRICE" ? "İsteğe bağlı. Gelirden düşülür." : "İsteğe bağlı. Bilgi amaçlı; net tutar zaten masraf düşülmüş hâlidir."}
        >
          <DecimalInput
            id={`${formId}-fees`}
            value={state.fees}
            onChange={(value) => update("fees", value)}
            placeholder="0"
            error={errors.fees}
          />
        </Field>

        <Field label="Not" htmlFor={`${formId}-note`} error={errors.note} hint="İsteğe bağlı.">
          <textarea
            id={`${formId}-note`}
            className="control resize-y"
            rows={2}
            maxLength={280}
            value={state.note}
            onChange={(event) => update("note", event.target.value)}
          />
        </Field>

        {preview?.netProceeds ? (
          <PreviewBox label="Net satış geliri" value={formatMoney(preview.netProceeds)}>
            <p className="mt-1 text-xs text-muted" data-testid="sell-preview-prices">
              {preview.quotedDisposalUnitPrice
                ? `Girilen brüt birim fiyat: ${formatMoney(preview.quotedDisposalUnitPrice)} · `
                : ""}
              Net birim tahsilat: {formatMoney(preview.effectiveNetUnitProceeds ?? "0")}
            </p>
          </PreviewBox>
        ) : null}

        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        {submitError ? <Alert tone="danger">{submitError}</Alert> : null}

        <FormActions
          busy={busy}
          submitLabel={editing ? "Düzeltmeyi kaydet" : "Satışı kaydet"}
          onCancel={onCancel}
          submitTestId="submit-sell"
        />
      </form>
    </Card>
  );
}

// ============================================================ MEVCUT ALTIN

interface OpeningState {
  productId: string;
  quantity: string;
  costMethod: OpeningCostMethod;
  costInputMode: OpeningCostInputMode;
  costAmount: string;
  note: string;
}

const COST_METHOD_LABELS: Record<OpeningCostMethod, { title: string; description: string }> = {
  MARKET_BASELINE: {
    title: "Bugünden itibaren takip et (önerilen)",
    description:
      "Maliyetinizi bilmiyorsanız: bugünkü bozdurma fiyatı başlangıç değeri olur; kâr/zarar bu andan itibaren hesaplanır.",
  },
  ACTUAL: {
    title: "Gerçek maliyetimi biliyorum",
    description: "Ortalama birim maliyet veya toplam maliyet girin; diğeri hesaplanır.",
  },
  ESTIMATED: {
    title: "Yaklaşık maliyetimi biliyorum",
    description: "Tahmini ortalama veya toplam maliyet girin. Pozisyon \"Tahmini maliyet\" olarak etiketlenir.",
  },
};

function BaselineQuotePanel({ quote, quantity, product }: { quote: PriceQuote; quantity: string; product: GoldProduct }) {
  const initialValue = toDecimalString(dec(quantity || "0").times(dec(quote.liquidationPrice)));
  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] border border-line bg-surface-2 p-3.5" data-testid="baseline-confirm">
      <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle">Bozdurma fiyatı (kuyumcu alış)</dt>
          <dd className="tabular font-semibold text-ink">{formatMoney(quote.liquidationPrice)} / {product.unit}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Yeniden alım fiyatı (kuyumcu satış)</dt>
          <dd className="tabular font-semibold text-ink">{formatMoney(quote.replacementPrice)} / {product.unit}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Sağlayıcı · piyasa</dt>
          <dd className="text-ink">
            {quote.provider} · {marketLabel(quote.market)}{" "}
            <span className="badge badge-notice">Test verisi</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Fiyat zamanı</dt>
          <dd className="text-ink">{formatDateTime(quote.providerTimestamp)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-subtle">Başlangıç değeri (miktar × bozdurma fiyatı)</dt>
          <dd className="tabular text-lg font-semibold text-ink" data-testid="baseline-initial-value">
            {formatMoney(initialValue)}
          </dd>
        </div>
      </dl>
      <p className="rounded-[var(--radius-sm)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--notice)]">
        Bu değer gerçek tarihsel alış maliyetiniz değildir. Kâr/zarar bu takip başlangıcından itibaren
        hesaplanacaktır. Kaydettiğiniz anda sunucunun aldığı fiyat esas alınır ve sonradan değişmez.
      </p>
    </div>
  );
}

export function OpeningBalanceForm({
  summary,
  onSubmit,
  onCancel,
}: {
  summary: AccountingSummary;
  onSubmit: (command: OpeningBalanceCommand) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [clientRequestId] = useState(() => createClientRequestId());
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [state, setState] = useState<OpeningState>({
    productId: "gram-altin",
    quantity: "",
    costMethod: "MARKET_BASELINE",
    costInputMode: "AVERAGE_UNIT_COST",
    costAmount: "",
    note: "",
  });
  const [errors, setErrors] = useState<CommandErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const product = getProduct(state.productId);
  /*
   * Kullanılabilirlik kararı MERKEZİ doğrulamadan gelir (src/prices/validate.ts).
   *
   * Burada eskiden `summary.priceStatus === "ok" && quote.status === "ok"`
   * yazıyordu. İki hatası vardı:
   *  1. `priceStatus` sağlayıcı META durumudur, değerleme kararı değildir.
   *     Hibrit planda üç kaynaktan biri düşünce "ok" olmaz ve FİYATI OLAN
   *     ürünlerde de bu seçenek kapanırdı.
   *  2. Kendi ölçütünü uydurup plan/bayatlık/sağlayıcı denetimlerini atlıyordu;
   *     sunucu kabul ederken ekran reddedebiliyordu (ya da tersi).
   */
  /*
   * Saat istemci tarafında ilerler; sunucu render'ında null döner (hidrasyon
   * bozulmasın diye). Saat gelmeden önce anlık görüntünün KENDİ zamanı esas
   * alınır: aksi hâlde seçenek bir an "kullanılamıyor" diye kapalı görünüp
   * hemen açılırdı. Sunucu her hâlükârda gönderimde yeniden doğrular.
   */
  const clock = useClientClock(30_000);
  const evaluatedAt = clock ?? Date.parse(summary.snapshot?.fetchedAt ?? "") ?? 0;
  const quote = usableQuoteOrNull(summary.snapshot, state.productId, Number.isFinite(evaluatedAt) ? evaluatedAt : 0);
  const baselineAvailable = quote !== null;

  const command = useMemo<OpeningBalanceCommand>(
    () => ({
    kind: "OPENING_BALANCE",
    productId: state.productId,
    quantity: state.quantity,
    costMethod: state.costMethod,
    costInputMode: state.costMethod === "MARKET_BASELINE" ? undefined : state.costInputMode,
    costAmount: state.costMethod === "MARKET_BASELINE" ? undefined : state.costAmount,
    note: state.note.trim(),
    clientRequestId,
    }),
    [state, clientRequestId],
  );
  const preview = useMemo(() => previewAmounts(command), [command]);

  function update<K extends keyof OpeningState>(key: K, value: OpeningState[K]) {
    setState((current) => ({ ...current, [key]: value }));
    setErrors({});
  }

  function validateStep1(): boolean {
    const probe = parseLedgerCommand({
      ...command,
      costMethod: "ACTUAL",
      costInputMode: "TOTAL_COST",
      costAmount: "1",
    });
    if (!probe.ok && (probe.errors.productId || probe.errors.quantity)) {
      setErrors({ productId: probe.errors.productId, quantity: probe.errors.quantity });
      return false;
    }
    return true;
  }

  function validateStep2(): boolean {
    if (state.costMethod === "MARKET_BASELINE") {
      if (!baselineAvailable) {
        setErrors({ form: "Güncel fiyat verisi kullanılamıyor; bu seçenek şu anda kullanılamaz." });
        return false;
      }
      return true;
    }
    const parsed = parseLedgerCommand(command);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return false;
    }
    return true;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(null);
    if (!validateStep2()) return;
    setBusy(true);
    try {
      await onSubmit(command);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Kayıt oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  const unit = product?.unit ?? "gram";
  const derivedOther = (() => {
    if (state.costMethod === "MARKET_BASELINE" || !preview?.totalPaid) return null;
    return state.costInputMode === "AVERAGE_UNIT_COST"
      ? `Toplam maliyet: ${formatMoney(preview.totalPaid)}`
      : `Ortalama birim maliyet: ${formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}`;
  })();

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Mevcut altınımı ekle</h2>
        <span className="text-xs text-subtle">Adım {step} / 3</span>
      </div>
      <p className="mt-1 text-sm text-muted">
        Geçmişten kalan altınlarınızı başlangıç bakiyesi olarak ekleyin. Bu bir alış işlemi değildir.
      </p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        {step === 1 ? (
          <>
            <ProductSelect
              id={`${formId}-product`}
              value={state.productId}
              onChange={(value) => update("productId", value)}
              error={errors.productId}
            />
            <QuantityField
              id={`${formId}-quantity`}
              product={product}
              value={state.quantity}
              onChange={(value) => update("quantity", value)}
              error={errors.quantity}
            />
            <p className="text-xs text-subtle">Birim: {unit}. Birim katalogdan gelir, değiştirilemez.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="btn btn-secondary min-h-11" onClick={onCancel}>
                Vazgeç
              </button>
              <button
                type="button"
                className="btn btn-primary min-h-11"
                data-testid="opening-next"
                onClick={() => {
                  if (validateStep1()) setStep(2);
                }}
              >
                Devam
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <fieldset>
              <legend className="field-label">Maliyet yöntemi</legend>
              <div className="space-y-2" role="radiogroup" aria-label="Maliyet yöntemi">
                {(["MARKET_BASELINE", "ACTUAL", "ESTIMATED"] as const).map((method) => {
                  const disabled = method === "MARKET_BASELINE" && !baselineAvailable;
                  return (
                    <button
                      key={method}
                      type="button"
                      role="radio"
                      aria-checked={state.costMethod === method}
                      disabled={disabled}
                      data-testid={`cost-method-${method}`}
                      onClick={() => update("costMethod", method)}
                      className={cx(
                        "w-full rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                        state.costMethod === method
                          ? "border-accent-line bg-accent-soft"
                          : "border-line-strong bg-surface hover:bg-surface-3",
                      )}
                    >
                      <span className={cx("block text-sm font-semibold", state.costMethod === method ? "text-accent" : "text-ink")}>
                        {COST_METHOD_LABELS[method].title}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                        {COST_METHOD_LABELS[method].description}
                        {disabled ? " (Güncel fiyat verisi kullanılamıyor.)" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {state.costMethod !== "MARKET_BASELINE" ? (
              <>
                <ModeToggle
                  label="Maliyet girişi"
                  value={state.costInputMode}
                  options={[
                    { value: "AVERAGE_UNIT_COST", label: "Ortalama birim maliyet" },
                    { value: "TOTAL_COST", label: "Toplam maliyet" },
                  ]}
                  onChange={(value) => update("costInputMode", value)}
                />
                <Field
                  label={
                    state.costInputMode === "AVERAGE_UNIT_COST"
                      ? `${state.costMethod === "ESTIMATED" ? "Tahmini o" : "O"}rtalama birim maliyet (TL / ${unit})`
                      : `${state.costMethod === "ESTIMATED" ? "Tahmini t" : "T"}oplam maliyet (TL)`
                  }
                  htmlFor={`${formId}-cost`}
                  error={errors.costAmount}
                  hint={derivedOther ?? "Diğer değer otomatik hesaplanır."}
                >
                  <DecimalInput
                    id={`${formId}-cost`}
                    value={state.costAmount}
                    onChange={(value) => update("costAmount", value)}
                    placeholder={state.costInputMode === "AVERAGE_UNIT_COST" ? "3.800,00" : "57.000,00"}
                    error={errors.costAmount}
                  />
                </Field>
              </>
            ) : null}

            {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <button type="button" className="btn btn-ghost min-h-11" onClick={() => setStep(1)}>
                ← Geri
              </button>
              <button
                type="button"
                className="btn btn-primary min-h-11"
                data-testid="opening-next"
                onClick={() => {
                  if (validateStep2()) setStep(3);
                }}
              >
                Devam
              </button>
            </div>
          </>
        ) : null}

        {step === 3 && product ? (
          <>
            <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3.5 py-3 text-sm">
              <p className="font-semibold text-ink">
                {displayProductName(product.id, product.name, { distinguish: true })} ·{" "}
                {formatQuantity(state.quantity, unit)}
              </p>
              <p className="mt-0.5 text-xs text-muted">{COST_METHOD_LABELS[state.costMethod].title}</p>
            </div>

            {state.costMethod === "MARKET_BASELINE" && quote ? (
              <BaselineQuotePanel quote={quote} quantity={state.quantity} product={product} />
            ) : preview?.totalPaid ? (
              <PreviewBox
                label={state.costMethod === "ESTIMATED" ? "Tahmini toplam maliyet" : "Toplam maliyet"}
                value={formatMoney(preview.totalPaid)}
              >
                <p className="mt-1 text-xs text-muted">
                  Ortalama birim maliyet: {formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}
                  {state.costMethod === "ESTIMATED" ? " · Tahmini maliyet olarak etiketlenir." : ""}
                </p>
              </PreviewBox>
            ) : null}

            <Field label="Not" htmlFor={`${formId}-note`} error={errors.note} hint="İsteğe bağlı.">
              <textarea
                id={`${formId}-note`}
                className="control resize-y"
                rows={2}
                maxLength={280}
                value={state.note}
                onChange={(event) => update("note", event.target.value)}
              />
            </Field>

            {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
            {submitError ? <Alert tone="danger">{submitError}</Alert> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <button type="button" className="btn btn-ghost min-h-11" onClick={() => setStep(2)} disabled={busy}>
                ← Geri
              </button>
              <button type="submit" className="btn btn-primary min-h-11" disabled={busy} data-testid="submit-opening">
                {busy ? "Kaydediliyor…" : "Mevcut altını kaydet"}
              </button>
            </div>
          </>
        ) : null}
      </form>
    </Card>
  );
}

export function firstError(errors: CommandErrors): string | null {
  return firstErrorText(errors);
}
