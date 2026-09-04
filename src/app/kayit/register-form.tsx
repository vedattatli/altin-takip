"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field } from "@/components/ui";

/**
 * Kayıt formu — kullanıcı adı, görünen ad, parola, parola tekrarı.
 *
 * E-posta, telefon, tek kullanımlık kod veya sihirli bağlantı YOKTUR.
 * Parola tekrarı burada da kontrol edilir ama bu yalnızca KOLAYLIKTIR:
 * gerçek denetim sunucudadır, istemci kontrolü güvenlik önlemi sayılmaz.
 *
 * Parolayı kullanıcı kendi seçtiği için ilk girişte parola değiştirme
 * istenmez; kayıt başarılıysa doğrudan panele geçilir.
 */
export function RegisterForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  // Anında geri bildirim; gönderimi ENGELLEMEZ, sunucu yine doğrular.
  const mismatch = passwordConfirm.length > 0 && password !== passwordConfirm;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, displayName, password, passwordConfirm, keepSignedIn }),
      });
      router.replace("/panel");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
      );
      setPassword("");
      setPasswordConfirm("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" method="post" onSubmit={handleSubmit} noValidate>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Kullanıcı adı" htmlFor="username" hint="Giriş yaparken bunu kullanacaksınız.">
        <input
          id="username"
          name="username"
          className="control"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>

      <Field label="Görünen ad" htmlFor="displayName" hint="Uygulamada size nasıl seslenelim?">
        <input
          id="displayName"
          name="displayName"
          className="control"
          autoComplete="name"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>

      <Field label="Parola" htmlFor="password">
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            className="control pr-20"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            aria-pressed={showPassword}
            className="absolute inset-y-1 right-1 rounded-[6px] px-2.5 text-xs font-semibold text-muted hover:bg-surface-3 hover:text-ink"
          >
            {showPassword ? "Gizle" : "Göster"}
          </button>
        </div>
      </Field>

      <Field label="Parola (tekrar)" htmlFor="passwordConfirm" error={mismatch ? "Parolalar eşleşmiyor." : undefined}>
        <input
          id="passwordConfirm"
          name="passwordConfirm"
          type={showPassword ? "text" : "password"}
          className="control"
          autoComplete="new-password"
          required
          value={passwordConfirm}
          onChange={(event) => setPasswordConfirm(event.target.value)}
        />
      </Field>

      <label className="flex items-start gap-2.5 text-sm text-muted">
        <input
          type="checkbox"
          name="keepSignedIn"
          className="mt-0.5 h-4 w-4"
          checked={keepSignedIn}
          onChange={(event) => setKeepSignedIn(event.target.checked)}
        />
        <span>
          <span className="font-medium text-ink">Bu cihazda oturumumu açık tut</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-subtle">
            İşaretlerseniz siz çıkış yapana kadar oturumunuz açık kalır.
          </span>
        </span>
      </label>

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Hesap oluşturuluyor…" : "Hesap oluştur"}
      </button>
    </form>
  );
}
