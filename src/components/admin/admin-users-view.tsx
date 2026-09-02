"use client";

import Link from "next/link";
import { useState } from "react";

import { generateTemporaryPassword, PASSWORD_RULES_TR } from "@/auth/password";
import { STATUS_LABELS, type UserProfile } from "@/auth/types";
import { USERNAME_RULES_TR } from "@/auth/username";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { Alert, Card, Field, SectionTitle, cx } from "../ui";

function StatusBadge({ status }: { status: UserProfile["status"] }) {
  return (
    <span className={cx("badge", status === "active" ? "badge-positive" : "badge-negative")}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function AdminUsersView({ initialUsers }: { initialUsers: UserProfile[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function runSearch(value: string) {
    setSearch(value);
    setSearching(true);
    try {
      const rows = await apiFetch<UserProfile[]>(
        `/api/admin/users?q=${encodeURIComponent(value)}`,
      );
      setUsers(rows);
    } catch {
      // Arama hatasında liste olduğu gibi bırakılır.
    } finally {
      setSearching(false);
    }
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const user = await apiFetch<UserProfile>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, displayName, temporaryPassword }),
      });
      setUsers((current) => [...current, user].sort((a, b) => a.username.localeCompare(b.username)));
      setCreated({ username: user.username, password: temporaryPassword });
      setUsername("");
      setDisplayName("");
      setTemporaryPassword("");
      setFormOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kullanıcı oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Yönetim</h1>
        <p className="mt-1 text-sm text-muted">
          Kullanıcı hesaplarını buradan oluşturur ve yönetirsiniz. Herkese açık kayıt yoktur.
        </p>
      </div>

      {created ? (
        <Alert tone="success" title="Kullanıcı oluşturuldu">
          <p>
            <span className="font-semibold">{created.username}</span> hesabı açıldı. Geçici parolayı
            kullanıcıya güvenli bir kanaldan iletin — bu parola bir daha gösterilmeyecek.
          </p>
          <p className="tabular mt-2 rounded-[var(--radius-sm)] bg-surface px-3 py-2 font-mono text-sm text-ink">
            {created.password}
          </p>
          <p className="mt-2 text-xs">Kullanıcı ilk girişinde kendi parolasını belirleyecek.</p>
        </Alert>
      ) : null}

      <SectionTitle
        title={`Kullanıcılar (${users.length})`}
        action={
          <button
            type="button"
            className="btn btn-primary"
            data-testid="open-create-user"
            onClick={() => {
              setFormOpen((current) => !current);
              setCreated(null);
            }}
          >
            {formOpen ? "Formu kapat" : "Yeni kullanıcı"}
          </button>
        }
      />

      {formOpen ? (
        <Card className="p-4 sm:p-5">
          <form className="space-y-4" onSubmit={handleCreate} noValidate>
            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Field
              label="Kullanıcı adı"
              htmlFor="new-username"
              hint={USERNAME_RULES_TR.slice(0, 3).join(" ")}
            >
              <input
                id="new-username"
                className="control"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>

            <Field label="Görünen ad" htmlFor="new-display-name">
              <input
                id="new-display-name"
                className="control"
                required
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>

            <Field
              label="Geçici parola"
              htmlFor="new-password"
              hint={PASSWORD_RULES_TR.join(" ")}
            >
              <div className="flex gap-2">
                <input
                  id="new-password"
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

            <p className="text-xs text-subtle">
              Kullanıcı ilk girişinde bu parolayı değiştirmek zorunda kalacak. Mevcut parolaları
              hiçbir zaman göremezsiniz.
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setFormOpen(false)}
                disabled={busy}
              >
                Vazgeç
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Oluşturuluyor…" : "Kullanıcıyı oluştur"}
              </button>
            </div>
          </form>
        </Card>
      ) : null}

      <Field label="Kullanıcı ara" htmlFor="user-search">
        <input
          id="user-search"
          className="control"
          type="search"
          placeholder="Kullanıcı adı veya görünen ad"
          value={search}
          onChange={(event) => void runSearch(event.target.value)}
        />
      </Field>

      <Card>
        {users.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">
            {searching ? "Aranıyor…" : "Kayıt bulunamadı."}
          </p>
        ) : (
          <ul data-testid="user-list">
            {users.map((user) => (
              <li key={user.id} className="border-b border-line last:border-b-0">
                <Link
                  href={`/yonetim/${user.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{user.displayName}</p>
                    <p className="truncate text-xs text-muted">
                      {user.username}
                      {user.role === "admin" ? " · Yönetici" : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-subtle">
                      {user.lastLoginAt
                        ? `Son giriş: ${formatDateTime(user.lastLoginAt)}`
                        : "Henüz giriş yapmadı"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge status={user.status} />
                    {user.mustChangePassword ? (
                      <span className="badge badge-notice">Parola değiştirmeli</span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
