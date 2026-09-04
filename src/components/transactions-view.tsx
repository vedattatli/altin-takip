"use client";

import { useState } from "react";

import {
  COST_QUALITY_LABELS,
  dec,
  type LedgerCommand,
  type LedgerEntry,
} from "@/domain/accounting";
import { requireProduct } from "@/domain/catalog";
import { formatDateTime, formatMoney, formatOccurred, formatQuantity } from "@/lib/format";
import { displayProductName } from "@/prices/valuation-plan";
import { usePortfolio } from "@/state/portfolio-store";
import { useViewMode } from "@/state/view-mode";
import { BuyForm, OpeningBalanceForm, SellForm } from "./ledger-forms";
import { Alert, Card, EmptyState, Field, SectionTitle, cx } from "./ui";

export type LedgerFormKind = "opening" | "buy" | "sell";

const KIND_LABELS: Record<LedgerEntry["kind"], string> = {
  OPENING_BALANCE: "Mevcut altın",
  BUY: "Alış",
  SELL: "Satış",
};

const STATUS_LABELS: Record<LedgerEntry["status"], string> = {
  ACTIVE: "Aktif",
  VOID: "İptal edildi",
  REPLACED: "Düzeltildi",
};

/**
 * Fiyat satırı: GİRİLEN fiyat ile masraflar dâhil EFEKTİF birim değer ayrı etiketlenir;
 * "birim alış fiyatı" adı altında efektif maliyet gösterilmez.
 */
function priceLine(entry: LedgerEntry): string {
  const unit = entry.unit;
  if (entry.kind === "SELL") {
    if (entry.quotedDisposalUnitPrice) {
      const net =
        entry.effectiveNetUnitProceeds && entry.effectiveNetUnitProceeds !== entry.quotedDisposalUnitPrice
          ? ` · Net ${formatMoney(entry.effectiveNetUnitProceeds)}/${unit}`
          : "";
      return `Birim satış ${formatMoney(entry.quotedDisposalUnitPrice)}/${unit}${net}`;
    }
    return entry.effectiveNetUnitProceeds
      ? `Net birim tahsilat ${formatMoney(entry.effectiveNetUnitProceeds)}/${unit} (net tutardan)`
      : "";
  }
  if (entry.quotedAcquisitionUnitPrice) {
    const effective =
      entry.effectiveAcquisitionUnitCost && entry.effectiveAcquisitionUnitCost !== entry.quotedAcquisitionUnitPrice
        ? ` · Efektif ${formatMoney(entry.effectiveAcquisitionUnitCost)}/${unit} (masraflar dâhil)`
        : "";
    const label = entry.costBasisOrigin === "MARKET_BASELINE" ? "Başlangıç fiyatı" : "Birim fiyat";
    return `${label} ${formatMoney(entry.quotedAcquisitionUnitPrice)}/${unit}${effective}`;
  }
  return entry.effectiveAcquisitionUnitCost
    ? `Efektif birim maliyet ${formatMoney(entry.effectiveAcquisitionUnitCost)}/${unit} (toplam tutardan)`
    : "";
}

function originLabel(entry: LedgerEntry): string | null {
  if (entry.kind === "SELL") return null;
  if (entry.costBasisOrigin === "ACTUAL") return COST_QUALITY_LABELS.ACTUAL;
  if (entry.costBasisOrigin === "ESTIMATED") return COST_QUALITY_LABELS.ESTIMATED;
  return COST_QUALITY_LABELS.BASELINE;
}

function LedgerRow({
  entry,
  onEdit,
  onVoid,
  busy,
}: {
  entry: LedgerEntry;
  onEdit: () => void;
  onVoid: () => void;
  busy: boolean;
}) {
  const product = requireProduct(entry.productId);
  const isSell = entry.kind === "SELL";
  const isActive = entry.status === "ACTIVE";
  const amount = isSell ? entry.netProceeds : entry.totalPaid;
  const prices = priceLine(entry);
  const origin = originLabel(entry);
  const hasFees = !dec(entry.fees).isZero();
  const hasWorkmanship = !dec(entry.workmanship).isZero();

  return (
    <li
      className={cx("border-b border-line px-4 py-3 last:border-b-0", !isActive && "opacity-70")}
      data-status={entry.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cx(
                "badge",
                entry.kind === "SELL" ? "badge-negative" : entry.kind === "BUY" ? "badge-positive" : "badge-notice",
              )}
            >
              {KIND_LABELS[entry.kind]}
            </span>
            {!isActive ? <span className="badge">{STATUS_LABELS[entry.status]}</span> : null}
            {origin ? <span className="badge">{origin}</span> : null}
            <p className="truncate text-sm font-semibold text-ink">
              {displayProductName(product.id, product.name, { distinguish: true })}
            </p>
          </div>
          <p className="tabular mt-1 text-xs text-muted" data-testid="ledger-row-summary">
            {formatQuantity(entry.quantity, entry.unit)} · {formatOccurred(entry.occurredAt, entry.occurredTime)}
          </p>
          {prices ? <p className="tabular mt-0.5 text-xs text-muted">{prices}</p> : null}
          {hasFees || hasWorkmanship ? (
            <p className="tabular mt-0.5 text-xs text-subtle">
              {hasWorkmanship ? `İşçilik: ${formatMoney(entry.workmanship)}` : ""}
              {hasWorkmanship && hasFees ? " · " : ""}
              {hasFees ? `Masraf: ${formatMoney(entry.fees)}` : ""}
              {entry.pricingInputMode === "TOTAL_AMOUNT" ? " (toplam tutarın içinde)" : ""}
            </p>
          ) : null}
          {entry.costBasisOrigin === "MARKET_BASELINE" && entry.priceSnapshot ? (
            <p className="mt-0.5 text-xs text-subtle">
              Anlık görüntü: {entry.priceSnapshot.provider} · {entry.priceSnapshot.market} ·{" "}
              {formatDateTime(entry.priceSnapshot.providerTimestamp)} · gerçek tarihsel maliyet değildir
            </p>
          ) : null}
          {entry.note ? <p className="mt-1 break-words text-xs text-subtle">{entry.note}</p> : null}
          {!isActive ? (
            <p className="mt-1 text-xs text-subtle">
              {STATUS_LABELS[entry.status]}
              {entry.voidedAt ? ` · ${formatDateTime(entry.voidedAt)}` : ""}
              {entry.voidReason ? ` · ${entry.voidReason}` : ""}
            </p>
          ) : null}
          {entry.replacesTransactionId ? (
            <p className="mt-1 text-xs text-subtle">Bir önceki kaydın düzeltilmiş hâlidir.</p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <p className={cx("tabular text-sm font-semibold text-ink", !isActive && "line-through")}>
            {amount ? formatMoney(amount) : "—"}
          </p>
          {isActive ? (
            <div className="flex gap-1">
              {entry.kind !== "OPENING_BALANCE" ? (
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  onClick={onEdit}
                  disabled={busy}
                >
                  Düzelt
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs text-negative"
                onClick={onVoid}
                disabled={busy}
              >
                İptal et
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function TransactionsView({ initialForm = null }: { initialForm?: LedgerFormKind | null }) {
  const { ledger, summary, appendTransaction, replaceTransaction, voidTransaction, status } =
    usePortfolio();
  const { isSimple } = useViewMode();
  const [form, setForm] = useState<LedgerFormKind | null>(initialForm);
  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  const [pendingVoid, setPendingVoid] = useState<LedgerEntry | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openForm(kind: LedgerFormKind, entry: LedgerEntry | null = null) {
    setForm(kind);
    setEditing(entry);
    setNotice(null);
    setError(null);
  }

  function closeForm() {
    setForm(null);
    setEditing(null);
  }

  async function handleSubmit(command: LedgerCommand) {
    if (editing) {
      await replaceTransaction(editing.id, command);
      setNotice("İşlem düzeltildi. Eski kayıt \"Düzeltildi\" olarak listede kalır.");
    } else {
      const result = await appendTransaction(command);
      setNotice(
        result.replayed
          ? "Bu işlem zaten kaydedilmişti; ikinci kez oluşturulmadı."
          : command.kind === "OPENING_BALANCE"
            ? "Mevcut altın eklendi."
            : command.kind === "BUY"
              ? "Alış eklendi."
              : "Satış eklendi.",
      );
    }
    closeForm();
  }

  async function confirmVoid() {
    if (!pendingVoid) return;
    setBusy(true);
    setError(null);
    try {
      await voidTransaction(pendingVoid.id, voidReason.trim());
      setNotice("İşlem iptal edildi. Kayıt silinmedi; \"İptal edildi\" olarak listede kalır.");
      setPendingVoid(null);
      setVoidReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "İşlem iptal edilemedi.");
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="py-16 text-center text-sm text-muted" role="status">
        İşlemleriniz yükleniyor…
      </div>
    );
  }

  /*
   * Basit modda satış düğmesi gösterilmez. Satış özelliği KALDIRILMADI:
   * detaylı moda geçince yerindedir, geçmiş satış kayıtları ve gerçekleşmiş
   * kâr/zarar hesabı her iki modda da aynen korunur.
   */
  const addButtons = form ? null : (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-secondary min-h-11" data-testid="add-opening" onClick={() => openForm("opening")}>
        Mevcut Altını Ekle
      </button>
      <button type="button" className="btn btn-primary min-h-11" data-testid="add-buy" onClick={() => openForm("buy")}>
        {isSimple ? "Altın Ekle" : "Yeni Alış Ekle"}
      </button>
      {isSimple ? null : (
        <button type="button" className="btn btn-secondary min-h-11" data-testid="add-sell" onClick={() => openForm("sell")}>
          Satış Ekle
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <SectionTitle
        title="İşlemler"
        description="Defter kaynak gerçektir: kayıtlar silinmez, iptal edilir veya düzeltilir."
      />
      {addButtons}

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {form === "opening" ? (
        <OpeningBalanceForm summary={summary} onSubmit={handleSubmit} onCancel={closeForm} />
      ) : null}
      {form === "buy" ? <BuyForm editing={editing} onSubmit={handleSubmit} onCancel={closeForm} /> : null}
      {form === "sell" ? (
        <SellForm summary={summary} editing={editing} onSubmit={handleSubmit} onCancel={closeForm} />
      ) : null}

      {pendingVoid ? (
        <Card className="border-negative-soft space-y-3 p-4">
          <p className="text-sm font-semibold text-ink">İşlem iptal edilsin mi?</p>
          <p className="text-sm text-muted">
            {displayProductName(pendingVoid.productId, requireProduct(pendingVoid.productId).name, {
              distinguish: true,
            })}{" "}
            ·{" "}
            {formatQuantity(pendingVoid.quantity, pendingVoid.unit)} ·{" "}
            {formatOccurred(pendingVoid.occurredAt, pendingVoid.occurredTime)}.
            Kayıt silinmez; &quot;İptal edildi&quot; olarak listede kalır ve toplamlar yeniden hesaplanır.
            Bir alışın iptali sonraki bir satışı eldeki miktarın üstüne çıkarıyorsa iptal reddedilir.
          </p>
          <Field label="Sebep" htmlFor="void-reason" hint="İsteğe bağlı.">
            <input
              id="void-reason"
              className="control min-h-11"
              maxLength={140}
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn btn-secondary min-h-11" onClick={() => setPendingVoid(null)} disabled={busy}>
              Vazgeç
            </button>
            <button
              type="button"
              className="btn btn-danger min-h-11"
              data-testid="confirm-void"
              onClick={() => void confirmVoid()}
              disabled={busy}
            >
              {busy ? "İptal ediliyor…" : "Evet, iptal et"}
            </button>
          </div>
        </Card>
      ) : null}

      <Card>
        {ledger.length === 0 ? (
          <EmptyState
            title="Henüz altın eklenmedi"
            description="Mevcut altınınızı ekleyin veya ilk alış işleminizi kaydedin; portföyünüz ve kâr/zarar hesabınız burada oluşmaya başlar."
            action={
              form ? undefined : (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => openForm("opening")}>
                  Mevcut Altını Ekle
                </button>
              )
            }
          />
        ) : (
          <ul data-testid="transaction-list">
            {ledger.map((entry) => (
              <LedgerRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onEdit={() => openForm(entry.kind === "SELL" ? "sell" : "buy", entry)}
                onVoid={() => {
                  setPendingVoid(entry);
                  setVoidReason("");
                  setNotice(null);
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
