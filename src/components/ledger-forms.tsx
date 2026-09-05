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
import type { GoldProduct, ProductCategory } from "@/domain/types";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { PriceQuote } from "@/prices/types";
import { usableQuoteOrNull } from "@/prices/validate";
import { usePortfolio } from "@/state/portfolio-store";
import { useViewMode } from "@/state/view-mode";
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

/**
 * VARLIK SEÇİMİ — TEK LİSTE, BAŞLIKLARA AYRILMIŞ, FİYATLI
 *
 * Ürünler tek bir açılır listede, üç başlık altında görünür:
 * Altınlar → Döviz → Gümüş. Ürünler KATALOG ADIYLA yazılır: "Yeni Çeyrek" ve
 * "Eski Çeyrek" ayrı satırlardır, birleştirilip "Çeyrek Altın" denmez —
 * kullanıcı hangisini eklediğini seçim anında bilmelidir.
 *
 * NEDEN "SIK KULLANILAN ALTI ÜRÜN" BÖLÜMÜ KALDIRILDI: liste iki bölüme
 * ayrılınca aynı ürün ailesi iki yerde görünüyordu (üstte "Çeyrek Altın",
 * altta "Yeni Çeyrek"/"Eski Çeyrek") ve hangisinin ne olduğu belirsizdi.
 * Tek liste + başlık, hem daha kısa hem daha kesin.
 *
 * FİYAT SATIRIN İÇİNDE, AMA İŞLEM YÖNÜNE GÖRE. Alış formunda YENİDEN ALIM
 * (kuyumcunun satış) fiyatı yazar — alırken ödeyeceğiniz taraf odur. Satış ve
 * "mevcut altınımı ekle" formlarında BOZDURMA (kuyumcunun alış) fiyatı yazar.
 * İki yönü karıştırmak, kullanıcıya ödemeyeceği bir rakamı referans gösterirdi.
 *
 * Fiyatı olmayan ürün GİZLENMEZ, "fiyat yok" yazılır — seçilebilir olduğu hâlde
 * neden değerlenemeyeceğini baştan bilir.
 *
 * SATIŞTA LİSTE KISALIR: `productIds` verilirse yalnızca o ürünler yazılır.
 * Satılacak bir şeyin listede olması için elde bulunması gerekir; olmayan ürünü
 * seçtirip gönderimde reddetmek kullanıcıyı boşuna dolaştırıyordu. Aşırı satış
 * denetimi yerinde durur (hem bu formda hem sunucuda).
 */
const SELECT_GROUPS: readonly { title: string; categories: readonly ProductCategory[] }[] = [
  { title: "Altınlar", categories: ["gram", "kulce", "ayarli", "ziynet"] },
  { title: "Döviz", categories: ["doviz"] },
  { title: "Gümüş", categories: ["gumus"] },
];

/** Başlıklarda adı geçmeyen bir kategori eklenirse ürünleri burada görünür. */
const SELECT_GROUPED_CATEGORIES = new Set(SELECT_GROUPS.flatMap((group) => group.categories));

function ProductSelect({
  id,
  value,
  onChange,
  error,
  productIds,
  priceKind,
}: {
  id: string;
  value: string;
  onChange: (productId: string) => void;
  error?: string;
  /** Verilirse liste bu ürünlerle sınırlanır; boş gelirse katalogun tamamı yazılır. */
  productIds?: readonly string[];
  /** Hangi yönün fiyatı yazılacak: alışta "yeniden alım", satışta "bozdurma". */
  priceKind: "liquidation" | "replacement";
}) {
  const { summary } = usePortfolio();
  const snapshot = summary.snapshot;
  const clock = useClientClock(30_000);
  // Saat gelmeden anlık görüntünün kendi zamanı kullanılır; hidrasyon bozulmasın.
  const fallback = Date.parse(snapshot?.fetchedAt ?? "");
  const now = clock ?? (Number.isFinite(fallback) ? fallback : 0);

  const groups = useMemo(() => {
    // Boş liste geldiğinde katalogun tamamına dönülür: seçeneksiz bir açılır
    // liste kullanıcıya hiçbir şey söylemez.
    const allowed = productIds && productIds.length > 0 ? new Set(productIds) : null;
    const catalog = allowed ? GOLD_PRODUCTS.filter((product) => allowed.has(product.id)) : GOLD_PRODUCTS;

    const label = (product: GoldProduct): string => {
      const quote = usableQuoteOrNull(snapshot, product.id, now);
      if (!quote) return `${product.name} — fiyat yok`;
      const price = priceKind === "replacement" ? quote.replacementPrice : quote.liquidationPrice;
      // `<option>` düz metindir; fiyat ada iliştirilir.
      return `${product.name} — ${formatMoney(price)}`;
    };

    const listed = SELECT_GROUPS.map((group) => ({
      title: group.title,
      products: catalog.filter((product) => group.categories.includes(product.category)).map(
        (product) => ({ id: product.id, label: label(product) }),
      ),
    })).filter((group) => group.products.length > 0);

    const rest = catalog.filter((product) => !SELECT_GROUPED_CATEGORIES.has(product.category));
    if (rest.length > 0) {
      listed.push({
        title: "Diğer",
        products: rest.map((product) => ({ id: product.id, label: label(product) })),
      });
    }
    return listed;
  }, [snapshot, now, priceKind, productIds]);

  return (
    <Field
      label="Varlık türü"
      htmlFor={id}
      error={error}
      hint={
        priceKind === "replacement"
          ? "Listedeki fiyat, bugün alsanız ödeyeceğiniz fiyattır."
          : "Listedeki fiyat, bugün bozdursanız alacağınız fiyattır."
      }
    >
      <select
        id={id}
        className="control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
      >
        {groups.map((group) => (
          <optgroup key={group.title} label={group.title}>
            {group.products.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
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
  /*
   * Ondalık izni ÜRÜNDEN gelir, birimden değil. Döviz de "adet" ile tutulur
   * ama bölünebilir; birime bakan eski sürüm kesirli döviz girişini engelliyordu.
   */
  const scale = product?.quantityScale ?? 6;
  const integer = scale === 0;
  return (
    <Field
      label={`Miktar (${unit})`}
      htmlFor={id}
      error={error}
      /*
       * İpucu YALNIZCA dışarıdan gelirse yazılır. Beklenen biçimi yer tutucu
       * gösteriyor; ondalık sınırı aşılırsa ayrıştırıcı alanın altında hata
       * veriyor. Bilgi kaybolmuyor, ihtiyaç anına erteleniyor.
       */
      hint={hint}
    >
      <DecimalInput
        id={id}
        value={value}
        onChange={onChange}
        placeholder={integer ? "1" : scale === 2 ? "1.500,50" : "10,5"}
        error={error}
        integer={integer}
      />
    </Field>
  );
}

/**
 * Tarih zorunlu, saat isteğe bağlı (aynı gün birden fazla işlemde gerçek sırayı
 * belirler). Saat alanı yalnızca DETAYLI modda görünür: saati girilmeyen kayıt
 * günün başlangıcı sayılır ve sıralama yine deterministiktir.
 */
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
  const { isSimple } = useViewMode();
  return (
    <div className={cx("grid gap-2", isSimple ? "grid-cols-1" : "grid-cols-[1fr_auto]")}>
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
      {isSimple ? null : (
        <Field label="Saat (isteğe bağlı)" htmlFor={`${formId}-time`} error={errors.occurredTime}>
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
      )}
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
  const { isSimple } = useViewMode();
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
    /*
     * Masraf alanları yalnızca UNIT_PRICE modunda ekrandadır ve yalnızca orada
     * gönderilir: toplam tutar modunda ödenen tutar zaten masrafları içerir,
     * ekranda görünmeyen bir masraf değeri hem hiçbir toplamı değiştirmez hem
     * de "Masraflar toplam ödenen tutarı aşamaz." hatasıyla kaydı engelleyebilirdi.
     */
    workmanship: state.mode === "UNIT_PRICE" ? state.workmanship || undefined : undefined,
    fees: state.mode === "UNIT_PRICE" ? state.fees || undefined : undefined,
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
      {/* Basit modda başlık, formu açan düğmenin ("Altın Ekle") sözcüğünü tekrarlar. */}
      <h2 className="text-base font-semibold text-ink">
        {editing ? "Alışı düzelt" : isSimple ? "Altın ekle" : "Yeni alış ekle"}
      </h2>
      <p className="mt-1 text-sm text-muted">Kuyumcuya ödediğiniz tutarı girin.</p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <ProductSelect
          priceKind="replacement"
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
          label="Tutarı nasıl gireceksiniz?"
          value={state.mode}
          options={[
            { value: "UNIT_PRICE", label: "Birim fiyat" },
            { value: "TOTAL_AMOUNT", label: "Ödediğiniz toplam" },
          ]}
          onChange={(value) => update("mode", value)}
        />

        {state.mode === "UNIT_PRICE" ? (
          <Field
            label="Birim alış fiyatı (TL)"
            htmlFor={`${formId}-unit-price`}
            error={errors.unitPrice}
            hint="Masraflar hariç, birim başına ödediğiniz fiyat."
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
            label="Ödediğiniz toplam (TL)"
            htmlFor={`${formId}-total-paid`}
            error={errors.totalPaid}
            hint="İşçilik ve komisyon bu tutarın içindedir."
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

        {state.mode === "UNIT_PRICE" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="İşçilik (TL)"
              htmlFor={`${formId}-workmanship`}
              error={errors.workmanship}
              hint="Maliyete eklenir."
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
              hint="Maliyete eklenir."
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
        ) : null}

        <Field label="Not" htmlFor={`${formId}-note`} error={errors.note}>
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
          <PreviewBox label="Ödediğiniz toplam" value={formatMoney(preview.totalPaid)}>
            {/* Girilen fiyat ile masraflı birim maliyet AYRI kalır; toplam tutar modunda girilen fiyat yoktur ve uydurulmaz. */}
            <p className="mt-1 text-xs text-muted" data-testid="buy-preview-prices">
              {preview.quotedAcquisitionUnitPrice
                ? `Girdiğiniz birim fiyat: ${formatMoney(preview.quotedAcquisitionUnitPrice)} · masraflarla birim maliyet: ${formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}`
                : `Masraflarla birim maliyet: ${formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}`}
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
  const openHoldings = useMemo(
    () => summary.holdings.filter((holding) => dec(holding.position.quantity).greaterThan(0)),
    [summary.holdings],
  );
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

  /* Satılacak bir şeyin listede olması için elde bulunması gerekir; düzeltmede
   * düzeltilen kaydın ürünü pozisyon kapanmış olsa da listede kalır. */
  const sellableProductIds = useMemo(() => {
    const ids = openHoldings.map((holding) => holding.product.id);
    if (editing && !ids.includes(editing.productId)) ids.push(editing.productId);
    return ids;
  }, [openHoldings, editing]);

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
    /* Masraf alanı yalnızca birim fiyat modunda ekrandadır: elinize geçen tutar
     * zaten masraf düşülmüş hâlidir, görünmeyen bir masraf oraya karışmamalı. */
    fees: state.mode === "UNIT_PRICE" ? state.fees || undefined : undefined,
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
            : `Elinizdeki miktardan fazlasını satamazsınız (${formatQuantity(availableForSale, state.productId)}).`,
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

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <ProductSelect
          priceKind="liquidation"
          id={`${formId}-product`}
          value={state.productId}
          onChange={(value) => update("productId", value)}
          error={errors.productId}
          productIds={sellableProductIds}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <QuantityField
            id={`${formId}-quantity`}
            product={product}
            value={state.quantity}
            onChange={(value) => update("quantity", value)}
            error={errors.quantity}
            /*
             * "BUGÜN" sözcüğü taşıyıcıdır: bu sayı GÜNCEL pozisyondur, seçilen
             * işlem tarihindeki değil. Geçmiş tarihli bir satışta motor defteri
             * kronolojik oynatır ve o gün elde daha az varsa reddeder; vaat
             * edilen miktarın hangi güne ait olduğu yazılmazsa kullanıcı
             * sunucudan gelen daha küçük sayıyı çelişki sanır.
             */
            hint={`Bugün elinizde ${formatQuantity(availableForSale, state.productId)} var.`}
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
          label="Tutarı nasıl gireceksiniz?"
          value={state.mode}
          options={[
            { value: "UNIT_PRICE", label: "Birim fiyat" },
            { value: "TOTAL_AMOUNT", label: "Elinize geçen" },
          ]}
          onChange={(value) => update("mode", value)}
        />

        {state.mode === "UNIT_PRICE" ? (
          <Field
            label="Birim satış fiyatı (TL)"
            htmlFor={`${formId}-unit-price`}
            error={errors.unitPrice}
            hint="Masraflar düşülmeden önceki birim fiyat."
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
          <Field label="Elinize geçen tutar (TL)" htmlFor={`${formId}-net`} error={errors.netProceeds}>
            <DecimalInput
              id={`${formId}-net`}
              value={state.netProceeds}
              onChange={(value) => update("netProceeds", value)}
              placeholder="16.800,00"
              error={errors.netProceeds}
            />
          </Field>
        )}

        {state.mode === "UNIT_PRICE" ? (
          <Field
            label="Satış masrafı (TL)"
            htmlFor={`${formId}-fees`}
            error={errors.fees}
            hint="Gelirden düşülür."
          >
            <DecimalInput
              id={`${formId}-fees`}
              value={state.fees}
              onChange={(value) => update("fees", value)}
              placeholder="0"
              error={errors.fees}
            />
          </Field>
        ) : null}

        <Field label="Not" htmlFor={`${formId}-note`} error={errors.note}>
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
          <PreviewBox label="Elinize geçen" value={formatMoney(preview.netProceeds)}>
            {/* Girilen fiyat ile masraf sonrası birim AYRI kalır; ikisi tek sayıya indirilmez. */}
            <p className="mt-1 text-xs text-muted" data-testid="sell-preview-prices">
              {preview.quotedDisposalUnitPrice
                ? `Girdiğiniz birim fiyat: ${formatMoney(preview.quotedDisposalUnitPrice)} · masraflar sonrası birim: ${formatMoney(preview.effectiveNetUnitProceeds ?? "0")}`
                : `Masraflar sonrası birim: ${formatMoney(preview.effectiveNetUnitProceeds ?? "0")}`}
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

const COST_METHOD_LABELS: Record<OpeningCostMethod, { title: string; description?: string }> = {
  MARKET_BASELINE: {
    title: "Kaça aldığımı bilmiyorum (önerilen)",
    description: "Kâr/zarar bugünden itibaren hesaplanır.",
  },
  ACTUAL: {
    // Açıklama yok: seçenek tıklandığı anda altında maliyet alanları açılıyor.
    title: "Kaça aldığımı biliyorum",
  },
  ESTIMATED: {
    title: "Yaklaşık hatırlıyorum",
    // Rozet panoda ve listede görünecek; nereden geldiği burada söylenir.
    description: "Listede \"Tahmini maliyet\" olarak işaretlenir.",
  },
};

function BaselineQuotePanel({
  quote,
  quantity,
  product,
  isTestData,
}: {
  quote: PriceQuote;
  /** KANONİK (noktalı) miktar dizesi — ham form metni decimal.js'i fırlatır. */
  quantity: string;
  product: GoldProduct;
  /** Uydurma veri uyarısı: lisanssız olmak ile gerçek olmamak ayrı şeylerdir. */
  isTestData: boolean;
}) {
  const initialValue = toDecimalString(dec(quantity || "0").times(dec(quote.liquidationPrice)));
  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] border border-line bg-surface-2 p-3.5" data-testid="baseline-confirm">
      <dl className="grid grid-cols-1 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-subtle">Bugünkü bozdurma fiyatı</dt>
          <dd className="tabular font-semibold text-ink">{formatMoney(quote.liquidationPrice)} / {product.unit}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Fiyat kaynağı</dt>
          <dd className="text-ink">
            {marketLabel(quote.market)}
            {/*
              Bu ekranda PriceSourceLine yoktur; kaydedilecek başlangıç değerinin
              uydurma veriden gelip gelmediğini söyleyen tek yer burasıdır.
              Metin price-source-line.tsx ile birebir aynıdır.
            */}
            {isTestData ? <span className="badge badge-notice ml-1">Gerçek piyasa verisi değil</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Başlangıç değeri</dt>
          <dd className="tabular text-lg font-semibold text-ink" data-testid="baseline-initial-value">
            {formatMoney(initialValue)}
          </dd>
        </div>
      </dl>
      <p className="rounded-[var(--radius-sm)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--notice)]">
        Bu tutar gerçek alış maliyetiniz değildir; kâr/zarar bugünden itibaren hesaplanır.
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
  /*
   * İKİ ADIM: 1) ürün + miktar + maliyet yöntemi, 2) onay.
   * Eskiden maliyet yöntemi tek başına bir adımdı; varsayılan seçenekle gelen
   * kullanıcı orada hiçbir şey yazmadan "Devam" diyordu — bir tıklık boş adım.
   */
  const [step, setStep] = useState<1 | 2>(1);
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
  const parsedFetched = Date.parse(summary.snapshot?.fetchedAt ?? "");
  const evaluatedAt = clock ?? (Number.isFinite(parsedFetched) ? parsedFetched : 0);
  const quote = usableQuoteOrNull(summary.snapshot, state.productId, evaluatedAt);
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

  /*
   * KANONİK MİKTAR — ham form metni ("10,5") biçimlendiriciye ve decimal.js'e
   * ASLA verilmez: decimal.js virgüllü dizede hata fırlatır ve onay adımı
   * çökerdi. Ayrıştırıcının ürettiği noktalı dize kullanılır. Not alanı burada
   * boşlanır: uzun bir not yüzünden miktarın "geçersiz" sayılması yanlış olur.
   */
  const canonicalQuantity = useMemo(() => {
    const probe = parseLedgerCommand({
      ...command,
      costMethod: "ACTUAL",
      costInputMode: "TOTAL_COST",
      costAmount: "1",
      note: "",
    });
    return probe.ok ? probe.request.quantity : null;
  }, [command]);

  function update<K extends keyof OpeningState>(key: K, value: OpeningState[K]) {
    setState((current) => ({ ...current, [key]: value }));
    setErrors({});
  }

  /** Adım 1'in tamamı: ürün, miktar ve seçilen maliyet yöntemi bir arada doğrulanır. */
  function validateStep1(): boolean {
    if (state.costMethod === "MARKET_BASELINE") {
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
      if (!baselineAvailable) {
        setErrors({ form: "Şu anda fiyat alınamıyor; bu seçeneği kullanamazsınız." });
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
    if (!validateStep1()) return;
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
  /*
   * Onay adımında beklerken fiyat bayatlayabilir (saat 30 saniyede bir ilerler).
   * O anda panel düşer; nedeni yazılmazsa ekran sessizce boşalır ve kaydet
   * düğmesi çalışmayacağı hâlde açık görünürdü.
   */
  const baselineBlocked = state.costMethod === "MARKET_BASELINE" && !baselineAvailable;
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
        <span className="text-xs text-subtle">Adım {step} / 2</span>
      </div>
      {/* "Yeni alış değil" ayrımı taşıyıcıdır: aynı altın iki yerden girilirse portföy ikiye katlanır. */}
      <p className="mt-1 text-sm text-muted">Elinizde zaten olan altınları ekleyin (yeni alış değil).</p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        {step === 1 ? (
          <>
            <ProductSelect
              priceKind="liquidation"
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

            <fieldset>
              <legend className="field-label">Maliyetini biliyor musunuz?</legend>
              <div className="space-y-2" role="radiogroup" aria-label="Maliyetini biliyor musunuz?">
                {(["MARKET_BASELINE", "ACTUAL", "ESTIMATED"] as const).map((method) => {
                  const disabled = method === "MARKET_BASELINE" && !baselineAvailable;
                  /* Soluk ve tıklanmaz görünen düğmenin nedeni yazılmazsa kullanıcı uygulamayı bozuk sanar. */
                  const detail = disabled
                    ? [COST_METHOD_LABELS[method].description, "Şu anda fiyat alınamıyor."]
                        .filter(Boolean)
                        .join(" — ")
                    : COST_METHOD_LABELS[method].description;
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
                      {detail ? (
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{detail}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {state.costMethod !== "MARKET_BASELINE" ? (
              <>
                <ModeToggle
                  label="Maliyeti nasıl gireceksiniz?"
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
                  hint={derivedOther ?? undefined}
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

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="btn btn-secondary min-h-11" onClick={onCancel}>
                Vazgeç
              </button>
              <button
                type="button"
                className="btn btn-primary min-h-11"
                data-testid="opening-next"
                onClick={() => {
                  // Geçildiğinde önceki denemenin hatası ekranda kalmasın.
                  if (validateStep1()) {
                    setErrors({});
                    setStep(2);
                  }
                }}
              >
                Devam
              </button>
            </div>
          </>
        ) : null}

        {step === 2 && product ? (
          <>
            <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3.5 py-3 text-sm">
              <p className="font-semibold text-ink">
                {product.name} ·{" "}
                {canonicalQuantity ? formatQuantity(canonicalQuantity, product.id) : "—"}
              </p>
              <p className="mt-0.5 text-xs text-muted">{COST_METHOD_LABELS[state.costMethod].title}</p>
            </div>

            {state.costMethod === "MARKET_BASELINE" ? (
              quote && canonicalQuantity ? (
                <BaselineQuotePanel
                  quote={quote}
                  quantity={canonicalQuantity}
                  product={product}
                  isTestData={summary.snapshot?.provider.isTestData === true}
                />
              ) : (
                <Alert tone="notice">Şu anda fiyat alınamıyor; bu seçeneği kullanamazsınız.</Alert>
              )
            ) : preview?.totalPaid ? (
              <PreviewBox
                label={state.costMethod === "ESTIMATED" ? "Tahmini toplam maliyet" : "Toplam maliyet"}
                value={formatMoney(preview.totalPaid)}
              >
                <p className="mt-1 text-xs text-muted">
                  Ortalama birim maliyet: {formatMoney(preview.effectiveAcquisitionUnitCost ?? "0")}
                </p>
              </PreviewBox>
            ) : null}

            <Field label="Not" htmlFor={`${formId}-note`} error={errors.note}>
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
              <button type="button" className="btn btn-ghost min-h-11" onClick={() => setStep(1)} disabled={busy}>
                ← Geri
              </button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <button type="button" className="btn btn-secondary min-h-11" onClick={onCancel} disabled={busy}>
                  Vazgeç
                </button>
                <button
                  type="submit"
                  className="btn btn-primary min-h-11"
                  disabled={busy || baselineBlocked}
                  data-testid="submit-opening"
                >
                  {busy ? "Kaydediliyor…" : "Mevcut altını kaydet"}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </form>
    </Card>
  );
}
