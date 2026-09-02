"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { generateTemporaryPassword } from "@/auth/password";
import { ROLE_LABELS, STATUS_LABELS, type UserProfile } from "@/auth/types";
import type { AdminUserPortfolioView } from "@/server/auth/service";
import {
  formatDateTime,
  formatGrams,
  formatMoney,
  formatQuantity,
  formatSignedMoney,
} from "@/lib/format";
import { Alert, Card, DeltaValue, Field, SectionTitle, cx } from "../ui";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | null;
  if (!response.ok) throw new Error(payload?.error ?? "İşlem tamamlanamadı.");
  return payload?.data as T;
}

export function AdminUserDetail({
  initial,
  isSelf,
}: {
  initial: AdminUserPortfolioView;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile>(initial.user);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resetOpen, setResetOpen] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmUsername, setConfirmUsername] = useState("");

  const { summary, transactions, canEdit } = initial;

  async function run<T>(action: () => Promise<T>, successMessage: string): Promise<T | null> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await action();
      setNotice(successMessage);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "İşlem tamamlanamadı.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: "active" | "inactive") {
    const updated = await run(
      () =>
        apiRequest<UserProfile>(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        }),
      status === "inactive"
        ? "Kullanıcı pasifleştirildi. Açık oturumları kapatıldı."
        : "Kullanıcı yeniden aktifleştirildi.",
    );
    if (updated) setUser(updated);
  }

  async function resetPassword(event: React.FormEvent) {
    event.preventDefault();
    const updated = await run(
      () =>
        apiRequest<UserProfile>(`/api/admin/users/${user.id}/password`, {
          method: "POST",
          body: JSON.stringify({ temporaryPassword }),
        }),
      "Geçici parola atandı. Kullanıcının tüm oturumları kapatıldı.",
    );
    if (updated) {
      setUser(updated);
      setIssuedPassword(temporaryPassword);
      setTemporaryPassword("");
      setResetOpen(false);
    }
  }

  async function deleteUser(event: React.FormEvent) {
    event.preventDefault();
    const result = await run(
      () =>
        apiRequest<{ deleted: boolean }>(`/api/admin/users/${user.id}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmUsername }),
        }),
      "Kullanıcı kalıcı olarak silindi.",
    );
    if (result?.deleted) {
      router.replace("/yonetim");
      router.refresh();
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          className="btn btn-ghost mb-2 px-0 text-sm"
          onClick={() => router.push("/yonetim")}
        >
          ← Kullanıcılar
        </button>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {user.displayName}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{user.username}</span>
          <span
            className={cx("badge", user.status === "active" ? "badge-positive" : "badge-negative")}
          >
            {STATUS_LABELS[user.status]}
          </span>
          <span className="badge">{ROLE_LABELS[user.role]}</span>
          {user.mustChangePassword ? (
            <span className="badge badge-notice">Parola değiştirmeli</span>
          ) : null}
        </p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {issuedPassword ? (
        <Alert tone="notice" title="Yeni geçici parola">
          <p>Kullanıcıya güvenli bir kanaldan iletin. Bu parola bir daha gösterilmeyecek.</p>
          <p className="mt-2 rounded-[var(--radius-sm)] bg-surface px-3 py-2 font-mono text-sm text-ink">
            {issuedPassword}
          </p>
        </Alert>
      ) : null}

      <section>
        <SectionTitle title="Hesap bilgileri" />
        <Card>
          <dl className="grid grid-cols-1 gap-y-3 p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-subtle">Oluşturulma</dt>
              <dd className="text-sm text-ink">{formatDateTime(user.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle">Son giriş</dt>
              <dd className="text-sm text-ink">
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Henüz giriş yapmadı"}
              </dd>
            </div>
          </dl>
        </Card>
      </section>

      <section>
        <SectionTitle
          title="Yönetim işlemleri"
          description="Varsayılan işlem pasifleştirmedir. Kalıcı silme ayrı ve açık onay ister."
        />
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {user.status === "active" ? (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="deactivate-user"
                onClick={() => void changeStatus("inactive")}
                disabled={busy || isSelf}
              >
                Pasifleştir
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="activate-user"
                onClick={() => void changeStatus("active")}
                disabled={busy}
              >
                Yeniden aktifleştir
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary"
              data-testid="open-reset-password"
              onClick={() => {
                setResetOpen((current) => !current);
                setDeleteOpen(false);
              }}
              disabled={busy}
            >
              Parolayı sıfırla
            </button>

            <button
              type="button"
              className="btn btn-ghost text-negative"
              data-testid="open-delete-user"
              onClick={() => {
                setDeleteOpen((current) => !current);
                setResetOpen(false);
              }}
              disabled={busy || isSelf}
            >
              Kalıcı olarak sil
            </button>
          </div>

          {isSelf ? (
            <p className="text-xs text-subtle">
              Kendi hesabınızı pasifleştiremez veya silemezsiniz.
            </p>
          ) : null}

          {resetOpen ? (
            <form className="space-y-3 border-t border-line pt-4" onSubmit={resetPassword}>
              <Field
                label="Yeni geçici parola"
                htmlFor="reset-password"
                hint="Kullanıcının mevcut parolasını göremezsiniz; yalnızca yeni bir geçici parola atayabilirsiniz."
              >
                <div className="flex gap-2">
                  <input
                    id="reset-password"
                    className="control font-mono"
                    required
                    value={temporaryPassword}
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary shrink-0"
                    onClick={() => setTemporaryPassword(generateTemporaryPassword())}
                  >
                    Üret
                  </button>
                </div>
              </Field>
              <button
                type="submit"
                className="btn btn-primary"
                data-testid="submit-reset-password"
                disabled={busy}
              >
                Parolayı sıfırla
              </button>
            </form>
          ) : null}

          {deleteOpen ? (
            <form className="space-y-3 border-t border-line pt-4" onSubmit={deleteUser}>
              <Alert tone="danger" title="Bu işlem geri alınamaz">
                <p>
                  <span className="font-semibold">{user.username}</span> hesabı ve buna bağlı{" "}
                  <span className="font-semibold">portföy kaydı ile {transactions.length} işlem</span>{" "}
                  kalıcı olarak silinecek. Verileri korumak istiyorsanız silme yerine{" "}
                  <span className="font-semibold">pasifleştirme</span> kullanın.
                </p>
              </Alert>
              <Field
                label={`Onaylamak için kullanıcı adını yazın: ${user.username}`}
                htmlFor="confirm-username"
              >
                <input
                  id="confirm-username"
                  className="control"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={confirmUsername}
                  onChange={(event) => setConfirmUsername(event.target.value)}
                />
              </Field>
              <button
                type="submit"
                className="btn btn-danger"
                data-testid="confirm-delete-user"
                disabled={busy || confirmUsername.trim().length === 0}
              >
                Kalıcı olarak sil
              </button>
            </form>
          ) : null}
        </Card>
      </section>

      <section>
        <SectionTitle
          title="Kullanıcının portföyü"
          description={
            canEdit
              ? "Bu kullanıcının kayıtlarını düzenleme yetkiniz var."
              : "Salt okunur görünüm. Kullanıcı adına finansal kayıt düzenleme yetkisi bu sürümde kapalıdır."
          }
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3.5">
            <p className="text-xs text-subtle">Toplam maliyet</p>
            <p className="tabular mt-1 text-base font-semibold text-ink">
              {formatMoney(summary.totalCostBasis)}
            </p>
          </Card>
          <Card className="p-3.5">
            <p className="text-xs text-subtle">Bozdurma değeri</p>
            <p className="tabular mt-1 text-base font-semibold text-ink">
              {formatMoney(summary.totalLiquidationValue)}
            </p>
          </Card>
          <Card className="p-3.5">
            <p className="text-xs text-subtle">Yeniden alım</p>
            <p className="tabular mt-1 text-base font-semibold text-ink">
              {formatMoney(summary.totalRepurchaseValue)}
            </p>
          </Card>
          <Card className="p-3.5">
            <p className="text-xs text-subtle">Kâr / Zarar</p>
            <p className="mt-1 text-base">
              <DeltaValue
                value={summary.totalUnrealizedPnL}
                formatted={formatSignedMoney(summary.totalUnrealizedPnL)}
              />
            </p>
          </Card>
        </div>

        <Card className="mt-3">
          {summary.positionCount === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              Bu kullanıcı henüz altın eklememiş.
            </p>
          ) : (
            <ul>
              {summary.holdings
                .filter((holding) => holding.quantity > 0)
                .map((holding) => (
                  <li
                    key={holding.product.id}
                    className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">
                        {holding.product.name}
                      </p>
                      <p className="text-xs text-muted">
                        {formatQuantity(holding.quantity, holding.product.unit)} ·{" "}
                        {formatGrams(holding.pureGoldGrams)} has
                      </p>
                    </div>
                    <p className="tabular shrink-0 text-sm font-semibold text-ink">
                      {holding.liquidationValue === null
                        ? "Fiyat yok"
                        : formatMoney(holding.liquidationValue)}
                    </p>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
