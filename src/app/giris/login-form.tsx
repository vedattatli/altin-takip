"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { type DeviceMode } from "@/auth/types";
import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field, cx } from "@/components/ui";

/**
 * Giriş formu.
 *
 * YALNIZCA kullanıcı adı, parola ve cihaz türü sorulur.
 * E-posta, telefon, tek kullanımlık kod, sihirli bağlantı, "beni hatırla"
 * kutusu veya kayıt bağlantısı YOKTUR.
 * Hata mesajı "kullanıcı yok" ile "parola yanlış" ayrımını yapmaz.
 */

const DEVICE_OPTIONS: { value: DeviceMode; label: string; description: string }[] = [
  {
    value: "shared",
    label: "Şirket / ortak cihaz",
    description:
      "Oturum tarayıcı kapanınca silinir, 15 dakika hareketsizlikte otomatik çıkış yapılır ve cihazda veri bırakılmaz.",
  },
  {
    value: "personal",
    label: "Kişisel cihaz",
    description: "Oturumunuz bu cihazda hatırlanır.",
  },
];

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Güvenli varsayılan: aksi açıkça seçilmedikçe ortak cihaz kabul edilir.
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("shared");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  const timedOut = searchParams.get("sebep") === "zaman-asimi";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await apiFetch<{ user: { mustChangePassword: boolean } }>(
        "/api/auth/login",
        { method: "POST", body: JSON.stringify({ username, password, deviceMode }) },
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
      {timedOut && !error ? (
        <Alert tone="notice">
          Hareketsizlik nedeniyle oturumunuz güvenlik için kapatıldı. Lütfen tekrar giriş yapın.
        </Alert>
      ) : null}

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

      <fieldset>
        <legend className="field-label">Bu cihaz</legend>
        <div className="space-y-2" role="radiogroup" aria-label="Bu cihaz">
          {DEVICE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={deviceMode === option.value}
              onClick={() => setDeviceMode(option.value)}
              className={cx(
                "w-full rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors",
                deviceMode === option.value
                  ? "border-accent-line bg-accent-soft"
                  : "border-line-strong bg-surface hover:bg-surface-3",
              )}
            >
              <span
                className={cx(
                  "block text-sm font-semibold",
                  deviceMode === option.value ? "text-accent" : "text-ink",
                )}
              >
                {option.label}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Giriş yapılıyor…" : "Giriş yap"}
      </button>
    </form>
  );
}
