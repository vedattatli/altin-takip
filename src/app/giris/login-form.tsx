"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field } from "@/components/ui";

/**
 * Giriş formu.
 *
 * YALNIZCA kullanıcı adı ve parola sorulur. E-posta, telefon, tek kullanımlık
 * kod, sihirli bağlantı, cihaz türü seçimi, "beni hatırla" kutusu veya kayıt
 * bağlantısı YOKTUR: oturum her cihazda zaten kalıcıdır ve yalnızca kullanıcı
 * çıkış yapınca kapanır.
 * Hata mesajı "kullanıcı yok" ile "parola yanlış" ayrımını yapmaz.
 */
export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
        { method: "POST", body: JSON.stringify({ username, password }) },
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

      <p className="text-xs leading-relaxed text-subtle">
        Bu cihazda bir kez giriş yaparsınız; siz çıkış yapana kadar oturumunuz açık kalır.
      </p>

      <button type="submit" className="btn btn-primary w-full" disabled={busy || !hydrated}>
        {busy ? "Giriş yapılıyor…" : "Giriş yap"}
      </button>
    </form>
  );
}
