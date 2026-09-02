"use client";

import { useMemo, useState } from "react";

import { requireProduct } from "@/domain/catalog";
import { sortTransactions, transactionNetAmount } from "@/domain/portfolio";
import type { Transaction, TransactionInput } from "@/domain/types";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { usePortfolio } from "@/state/portfolio-store";
import { TransactionForm } from "./transaction-form";
import { Alert, Card, EmptyState, SectionTitle, cx } from "./ui";

function TransactionRow({
  transaction,
  onEdit,
  onDelete,
  busy,
}: {
  transaction: Transaction;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const product = requireProduct(transaction.productId);
  const isBuy = transaction.side === "buy";
  const amount = transactionNetAmount(transaction);

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("badge", isBuy ? "badge-positive" : "badge-negative")}>
              {isBuy ? "Alış" : "Satış"}
            </span>
            <p className="truncate text-sm font-semibold text-ink">{product.name}</p>
          </div>
          <p className="tabular mt-1 text-xs text-muted">
            {formatQuantity(transaction.quantity, transaction.unit)} ·{" "}
            {formatMoney(transaction.unitPrice)}/{transaction.unit} · {formatDate(transaction.tradedAt)}
          </p>
          {transaction.feeAmount > 0 ? (
            <p className="tabular mt-0.5 text-xs text-subtle">
              İşçilik / komisyon: {formatMoney(transaction.feeAmount)}
            </p>
          ) : null}
          {transaction.note ? (
            <p className="mt-1 break-words text-xs text-subtle">{transaction.note}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <p className="tabular text-sm font-semibold text-ink">{formatMoney(amount)}</p>
          <div className="flex gap-1">
            <button
              type="button"
              className="btn btn-ghost px-2.5 py-1 text-xs"
              onClick={onEdit}
              disabled={busy}
            >
              Düzenle
            </button>
            <button
              type="button"
              className="btn btn-ghost px-2.5 py-1 text-xs text-negative"
              onClick={onDelete}
              disabled={busy}
            >
              Sil
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function TransactionsView({ initialFormOpen = false }: { initialFormOpen?: boolean }) {
  const { transactions, addTransaction, editTransaction, removeTransaction, status } =
    usePortfolio();
  const [formOpen, setFormOpen] = useState(initialFormOpen);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const ordered = useMemo(() => sortTransactions(transactions).reverse(), [transactions]);

  async function handleSubmit(input: TransactionInput) {
    if (editing) {
      await editTransaction(editing.id, input);
      setNotice("İşlem güncellendi.");
    } else {
      await addTransaction(input);
      setNotice("İşlem eklendi.");
    }
    setFormOpen(false);
    setEditing(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await removeTransaction(pendingDelete.id);
      setNotice("İşlem silindi.");
      setPendingDelete(null);
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

  return (
    <div className="space-y-5">
      <SectionTitle
        title="İşlemler"
        description="Eklediğiniz her alış ve satış burada listelenir."
        action={
          formOpen ? undefined : (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="add-transaction"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
                setNotice(null);
              }}
            >
              Altın Ekle
            </button>
          )
        }
      />

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {formOpen ? (
        <TransactionForm
          transactions={transactions}
          editing={editing}
          onSubmit={handleSubmit}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}

      {pendingDelete ? (
        <Card className="border-negative-soft p-4">
          <p className="text-sm font-semibold text-ink">İşlem silinsin mi?</p>
          <p className="mt-1 text-sm text-muted">
            {requireProduct(pendingDelete.productId).name} ·{" "}
            {formatQuantity(pendingDelete.quantity, pendingDelete.unit)} ·{" "}
            {formatDate(pendingDelete.tradedAt)}. Bu işlem geri alınamaz ve toplamlarınız yeniden
            hesaplanır.
          </p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPendingDelete(null)}
              disabled={busy}
            >
              Vazgeç
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-testid="confirm-delete"
              onClick={() => void confirmDelete()}
              disabled={busy}
            >
              {busy ? "Siliniyor…" : "Evet, sil"}
            </button>
          </div>
        </Card>
      ) : null}

      <Card>
        {ordered.length === 0 ? (
          <EmptyState
            title="Henüz altın eklenmedi"
            description="İlk işleminizi eklediğinizde portföyünüz ve kâr/zarar hesabınız burada oluşmaya başlar."
            action={
              formOpen ? undefined : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  Altın Ekle
                </button>
              )
            }
          />
        ) : (
          <ul data-testid="transaction-list">
            {ordered.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                busy={busy}
                onEdit={() => {
                  setEditing(transaction);
                  setFormOpen(true);
                  setNotice(null);
                }}
                onDelete={() => {
                  setPendingDelete(transaction);
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
