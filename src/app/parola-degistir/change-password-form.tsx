"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

      // Bu cihazdaki oturum korunur; diğer cihazlar güvenlik için kapatıldı.
      setDone(true);
      setTimeout(() => {
        router.replace("/panel");
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
        Diğer cihazlarda yeniden giriş yapmanız gerekecek.
      </Alert>
    );
  }

  return (
    <form className="space-y-4" method="post" onSubmit={handleSubmit} noValidate>
      {forced ? (
        <Alert tone="notice" title="Parolanızı değiştirmeniz gerekiyor">
          Hesabınıza geçici bir parola verilmiş.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Mevcut parola" htmlFor="current-password">
        <div className="relative">
          <input
            id="current-password"
            type={show ? "text" : "password"}
            className="control pr-20"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          {/* Tek düğme üç parola alanını birlikte açar; diğer giriş ekranlarıyla aynı kalıp. */}
          <button
            type="button"
            onClick={() => setShow((current) => !current)}
            aria-pressed={show}
            className="absolute inset-y-1 right-1 rounded-[6px] px-2.5 text-xs font-semibold text-muted hover:bg-surface-3 hover:text-ink"
          >
            {show ? "Gizle" : "Göster"}
          </button>
        </div>
      </Field>

      <Field
        label="Yeni parola"
        htmlFor="new-password"
        hint="En az 10 karakter olmalı, harf ve rakam içermeli."
      >
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

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Kaydediliyor…" : "Parolayı değiştir"}
      </button>
    </form>
  );
}
