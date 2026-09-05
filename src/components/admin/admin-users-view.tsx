"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { generateTemporaryPassword } from "@/auth/password";
import { STATUS_LABELS, type UserProfile } from "@/auth/types";
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

  /*
   * Her tuş vuruşu bir istek başlattığı için yanıtlar sırasız dönebilir. Artan
   * sıra sayacı sayesinde yalnızca EN SON isteğin yanıtı listeye yazılır; geç
   * dönen eski yanıt hem listeyi hem "Aranıyor…" durumunu bozamaz.
   */
  const searchSeq = useRef(0);

  async function runSearch(value: string) {
    setSearch(value);
    setSearching(true);
    setError(null);
    const mine = ++searchSeq.current;
    try {
      const rows = await apiFetch<UserProfile[]>(
        `/api/admin/users?q=${encodeURIComponent(value)}`,
      );
      if (mine !== searchSeq.current) return;
      setUsers(rows);
    } catch {
      if (mine !== searchSeq.current) return;
      // Sessiz yutulursa önceki aramanın satırları yeni sonuç sanılır.
      setError("Arama yapılamadı.");
    } finally {
      if (mine === searchSeq.current) setSearching(false);
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
          Kullanıcı hesaplarını buradan oluşturur ve yönetirsiniz.
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
        </Alert>
      ) : null}

      <SectionTitle
        title={
          search.trim() ? `Arama sonuçları (${users.length})` : `Kullanıcılar (${users.length})`
        }
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
            <Field
              label="Kullanıcı adı"
              htmlFor="new-username"
              hint="3-32 karakter · küçük harf, rakam, . _ - · harfle başlar"
            >
              <input
                id="new-username"
                className="control"
                aria-describedby="new-username-hint"
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
              hint="En az 10 karakter; harf ve rakam içermeli."
            >
              <div className="flex gap-2">
                <input
                  id="new-password"
                  className="control font-mono"
                  aria-describedby="new-password-hint"
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

      {/* Tek hata yüzeyi: hem form hem arama hatası burada görünür. */}
      {error ? <Alert tone="danger">{error}</Alert> : null}

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
                    {/* Yeni hesapta zaten "Henüz giriş yapmadı" yazıyor; rozet yalnızca
                        giriş yapmış bir hesabın parolası sıfırlandığında bilgi taşır. */}
                    {user.mustChangePassword && user.lastLoginAt ? (
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
