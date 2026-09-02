"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field } from "@/components/ui";

/**
 * Giriş formu.
 *
 * Kullanıcı adı, parola ve tek bir tercih: "Bu cihazda oturumumu açık tut".
 * E-posta, telefon, tek kullanımlık kod, sihirli bağlantı, cihaz türü seçimi
 * veya kayıt bağlantısı YOKTUR. Tercih tarayıcı deposuna yazılmaz; sunucudaki
 * oturum kaydında tutulur. Yöneticiler için sunucu tercihi yok sayar.
 * Hata mesajı "kullanıcı yok" ile "parola yanlış" ayrımını yapmaz.
 */
export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Güvenli varsayılan: işaretsiz -> tarayıcı oturumu (kapanınca biter).
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await apiFetch<{ user: { mustChangePassword: boolean } }>(
        "/api/auth/login",
        { method: "POST", body: JSON.stringify({ username, password, keepSignedIn }) },
      );
      router.replace(result.user.mustChangePassword ? "/parola-degistir" : "/panel");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.",
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    // method="post": hidrasyon tamamlanmadan bir gönderim olursa bile
    // kimlik bilgileri adres çubuğuna (GET sorgusuna) YAZILMAZ.
    <form className="space-y-4" method="post" onSubmit={handleSubmit} noValidate>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Kullanıcı adı" htmlFor="username">
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

      <Field label="Parola" htmlFor="password">
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            className="control pr-20"
            autoComplete="current-password"
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
            İşaretlerseniz siz çıkış yapana kadar oturumunuz açık kalır. İşaretlemezseniz
            tarayıcıyı kapatınca veya 30 dakika hareketsiz kalınca oturum sona erer.
          </span>
        </span>
      </label>

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Giriş yapılıyor…" : "Giriş yap"}
      </button>
    </form>
  );
}
