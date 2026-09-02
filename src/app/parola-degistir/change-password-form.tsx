"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PASSWORD_RULES_TR } from "@/auth/password";
import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field } from "@/components/ui";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== repeatPassword) {
      setError("Yeni parolalar eşleşmiyor.");
      return;
    }

    setBusy(true);
    try {
      await apiFetch<{ changed: boolean }>("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      // Güvenlik gereği tüm oturumlar düştü; kullanıcı yeni parolayla tekrar girer.
      setDone(true);
      setTimeout(() => {
        router.replace("/giris");
        router.refresh();
      }, 1800);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Alert tone="success" title="Parolanız güncellendi">
        Güvenlik için tüm cihazlardaki oturumlar kapatıldı. Giriş ekranına yönlendiriliyorsunuz…
      </Alert>
    );
  }

  return (
    <form className="space-y-4" method="post" onSubmit={handleSubmit} noValidate>
      {forced ? (
        <Alert tone="notice" title="Parolanızı değiştirmeniz gerekiyor">
          Hesabınıza geçici bir parola atanmış. Devam etmek için kendi parolanızı belirleyin.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Mevcut parola" htmlFor="current-password">
        <input
          id="current-password"
          type={show ? "text" : "password"}
          className="control"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </Field>

      <Field label="Yeni parola" htmlFor="new-password">
        <input
          id="new-password"
          type={show ? "text" : "password"}
          className="control"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </Field>

      <Field label="Yeni parola (tekrar)" htmlFor="repeat-password">
        <input
          id="repeat-password"
          type={show ? "text" : "password"}
          className="control"
          autoComplete="new-password"
          required
          value={repeatPassword}
          onChange={(event) => setRepeatPassword(event.target.value)}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={show}
          onChange={(event) => setShow(event.target.checked)}
          className="h-4 w-4"
        />
        Parolaları göster
      </label>

      <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3.5 py-3">
        <p className="text-xs font-semibold text-muted">Parola kuralları</p>
        <ul className="mt-1.5 space-y-1 text-xs text-subtle">
          {PASSWORD_RULES_TR.map((rule) => (
            <li key={rule}>• {rule}</li>
          ))}
        </ul>
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Kaydediliyor…" : "Parolayı değiştir"}
      </button>
    </form>
  );
}
