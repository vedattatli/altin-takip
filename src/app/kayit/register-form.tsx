"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { validatePassword } from "@/auth/password";
import { validateUsername } from "@/auth/username";
import { useHydrated } from "@/components/hydration-marker";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Alert, Field } from "@/components/ui";

/**
 * Kayıt formu — kullanıcı adı, parola, parola tekrarı.
 *
 * E-posta, telefon, tek kullanımlık kod veya sihirli bağlantı YOKTUR.
 * Kullanıcı adı, parola politikası ve parola tekrarı burada da kontrol edilir
 * ama bu yalnızca KOLAYLIKTIR: gerçek denetim sunucudadır, istemci kontrolü
 * güvenlik önlemi sayılmaz. İstemcide durduruyoruz çünkü kayıt ucunun hız
 * sınırlayıcısı BAŞARISIZ denemeyi de sayar; yazım hatası kullanıcının kayıt
 * hakkını yakmasın diye istek gönderilmeden önce uyarıyoruz.
 *
 * Parolayı kullanıcı kendi seçtiği için ilk girişte parola değiştirme
 * istenmez; kayıt başarılıysa doğrudan panele geçilir.
 */
export function RegisterForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  // Anında geri bildirim; ayrıca gönderimi de engeller (aşağıdaki düğme).
  const mismatch = passwordConfirm.length > 0 && password !== passwordConfirm;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Erken dönüşler finally'ye girmediği için bu kontroller setBusy'den ÖNCE olmalı.
    const uname = validateUsername(username);
    if (!uname.ok) {
      setError(uname.error);
      return;
    }
    if (password !== passwordConfirm) {
      setError("Parolalar birbiriyle eşleşmiyor.");
      return;
    }
    const policy = validatePassword(password, uname.value);
    if (!policy.ok) {
      setError(policy.error);
      return;
    }

    setBusy(true);

    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        // Görünen ad ayrı sorulmaz: sunucu 2-80 karakter ister, kullanıcı adı
        // zaten 3-32 karakter olduğu için bu kural her zaman karşılanır.
        body: JSON.stringify({
          username,
          displayName: username,
          password,
          passwordConfirm,
          keepSignedIn,
        }),
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

      <Field label="Kullanıcı adı" htmlFor="username" hint="Boşluksuz yazın, en az 3 harf olsun.">
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

      <Field label="Parola" htmlFor="password" hint="En az 10 karakter; harf ve rakam içermeli.">
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

      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          name="keepSignedIn"
          className="h-4 w-4"
          checked={keepSignedIn}
          onChange={(event) => setKeepSignedIn(event.target.checked)}
        />
        <span className="font-medium text-ink">Bu cihazda oturumumu açık tut</span>
      </label>

      <button
        type="submit"
        className="btn btn-primary w-full"
        disabled={busy || !hydrated || mismatch}
      >
        {busy ? "Hesap oluşturuluyor…" : "Hesap oluştur"}
      </button>
    </form>
  );
}
