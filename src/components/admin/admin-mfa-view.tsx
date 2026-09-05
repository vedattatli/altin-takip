"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { Alert, Card, Field } from "../ui";

/**
 * Yönetici ikinci faktörü (TOTP).
 *
 * - Secret ve kurtarma kodları YALNIZCA kurulum anında bir kez gösterilir.
 * - Kodlar panoya kopyalanabilir; hiçbir yere kaydedilmez veya loglanmaz.
 * - Doğrulama tamamlanmadan yönetim paneli açılmaz.
 */

export interface MfaStatus {
  state: "not_required" | "not_enrolled" | "pending_confirmation" | "enrolled";
  sessionVerified: boolean;
  configured: boolean;
}

interface EnrollmentPayload {
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
  recoveryCodes: string[];
}

export function AdminMfaView({
  initialStatus,
  username,
}: {
  initialStatus: MfaStatus;
  username: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus>(initialStatus);
  const [enrollment, setEnrollment] = useState<EnrollmentPayload | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsEnrollment = status.state === "not_enrolled" || status.state === "pending_confirmation";

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<EnrollmentPayload>("/api/auth/mfa/enroll", { method: "POST" });
      setEnrollment(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kurulum başlatılamadı.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(path: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      setStatus({ ...status, state: "enrolled", sessionVerified: true });
      router.replace("/yonetim");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kod doğrulanamadı.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      router.replace("/giris");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!status.configured) {
    return (
      <Card className="p-5">
        <h1 className="text-lg font-semibold text-ink">Güvenlik doğrulaması yapılandırılmamış</h1>
        <p className="mt-2 break-words text-sm text-muted">
          Yönetici ikinci faktörü için sunucuda <code className="break-words">AUTH_MFA_ENCRYPTION_KEY</code>{" "}
          tanımlı olmalıdır.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5" data-testid="mfa-view">
      <h1 className="text-lg font-semibold text-ink">
        {needsEnrollment ? "İkinci faktörü kurun" : "Kimliğinizi doğrulayın"}
      </h1>
      <p className="mt-2 text-sm text-muted">Bu adımı tamamlamadan yönetim paneli açılmaz.</p>

      {needsEnrollment && !enrollment ? (
        <button
          type="button"
          className="btn btn-primary mt-4 min-h-11"
          onClick={() => void startEnrollment()}
          disabled={busy}
          data-testid="mfa-start"
        >
          {busy ? "Hazırlanıyor…" : "Kuruluma başla"}
        </button>
      ) : null}

      {enrollment ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 p-3.5">
            <p className="text-xs text-subtle">
              Doğrulayıcı uygulamanızda &quot;QR kodu tara&quot; deyip aşağıdaki kodu okutun.
            </p>
            <div className="mt-3 flex justify-center">
              {/* Beyaz zemin şart: karanlık tema üstünde QR okunmaz. */}
              {/* next/image kullanılmaz: kaynak gömülü bir data: URI'dir, optimize
                  edilecek uzak bir görsel yoktur ve secret dışarı çıkmamalıdır. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrollment.qrDataUri}
                alt="Kimlik doğrulayıcı uygulama için QR kodu"
                width={240}
                height={240}
                className="rounded-[var(--radius-sm)] bg-white p-2"
                data-testid="mfa-qr"
              />
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-subtle hover:text-muted">
                QR okutamıyorum, elle gireyim
              </summary>
              <p className="mt-2 text-xs text-subtle">
                Anahtarda yalnızca A–Z harfleri ve 2–7 rakamları vardır; 0, 1, 8, 9 veya küçük harf
                yoktur.
              </p>
              <p
                className="tabular mt-2 break-all text-sm font-semibold tracking-wider text-ink"
                data-testid="mfa-secret"
              >
                {enrollment.secret.replace(/(.{4})/gu, "$1 ").trim()}
              </p>
            </details>
          </div>
          <div className="rounded-[var(--radius-sm)] border border-[var(--notice-line)] bg-[var(--notice-soft)] p-3.5">
            <p className="text-xs font-semibold text-[var(--notice)]">
              Kurtarma kodları (her biri tek kullanımlık, bir daha gösterilmez)
            </p>
            <ul className="tabular mt-2 grid grid-cols-2 gap-1 text-xs text-[var(--notice)]">
              {enrollment.recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {(enrollment || !needsEnrollment) && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(enrollment ? "/api/auth/mfa/confirm" : "/api/auth/mfa/verify");
          }}
        >
          <Field
            label="Doğrulama kodu"
            htmlFor="mfa-code"
            hint={enrollment ? "Uygulamanızdaki 6 haneli kodu girin." : "6 haneli kod veya kurtarma kodu."}
          >
            <input
              id="mfa-code"
              className="control tabular min-h-11"
              inputMode="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              data-testid="mfa-code"
            />
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 w-full" disabled={busy} data-testid="mfa-submit">
            {busy ? "Doğrulanıyor…" : enrollment ? "Kurulumu tamamla" : "Doğrula"}
          </button>
        </form>
      )}

      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {/* Bu ekran (app) düzeninin dışındadır; üst menüdeki Çıkış düğmesi burada yoktur.
          Kod üretemeyen yönetici başka türlü ekranda kilitli kalır. */}
      <button
        type="button"
        className="btn btn-ghost mt-3 min-h-11 w-full"
        onClick={() => void signOut()}
        disabled={busy}
        data-testid="mfa-signout"
      >
        Çıkış yap
      </button>

      <p className="mt-4 text-xs text-subtle">Hesap: {username}</p>
    </Card>
  );
}
