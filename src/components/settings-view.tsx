"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SessionUser } from "@/auth/types";
import { appConfig } from "@/config/app.config";
import { apiFetch } from "@/lib/api-client";
import { usePortfolio } from "@/state/portfolio-store";
import { Alert, Card, Field, SectionTitle } from "./ui";

export function SettingsView({ user }: { user: SessionUser }) {
  const router = useRouter();
  const { portfolio, renamePortfolio, status, error: loadError } = usePortfolio();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [logoutAllBusy, setLogoutAllBusy] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  /** Silme talebi: veriyi burada SİLMEZ; talebi kaydeder ve süreci bildirir. */
  async function requestDeletion() {
    setDeletionBusy(true);
    setDeletionError(null);
    try {
      const result = await apiFetch<{ message: string }>("/api/account/deletion-request", {
        method: "POST",
        // Gövde boş kalamaz: `readJson` gövdesiz istekte 400 döndürür.
        body: JSON.stringify({}),
      });
      setDeletionNotice(result.message);
      setDeletionOpen(false);
    } catch (cause) {
      setDeletionError(cause instanceof Error ? cause.message : "Talep gönderilemedi.");
    } finally {
      setDeletionBusy(false);
    }
  }

  async function logoutEverywhere() {
    setLogoutAllBusy(true);
    setLogoutAllError(null);
    try {
      await apiFetch("/api/auth/logout-all", { method: "POST" });
      router.replace("/giris");
      router.refresh();
    } catch (cause) {
      setLogoutAllError(cause instanceof Error ? cause.message : "Çıkış yapılamadı.");
      setLogoutAllBusy(false);
    }
  }

  // Portföy yüklendiğinde form alanlarını bir kez doldur.
  // React'in önerdiği "render sırasında durum düzeltme" kalıbı; efekt gerekmez.
  const [loadedPortfolioId, setLoadedPortfolioId] = useState<string | null>(null);
  if (portfolio && portfolio.id !== loadedPortfolioId) {
    setLoadedPortfolioId(portfolio.id);
    setName(portfolio.name);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await renamePortfolio({ name: name.trim() || "Portföyüm" });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Ayarlar</h1>

      <section>
        <SectionTitle title="Portföy" />
        <Card className="p-4 sm:p-5">
          <form className="space-y-4" onSubmit={handleSave} noValidate>
            {status === "error" ? (
              <Alert tone="danger">
                {loadError ?? "Portföyünüz yüklenemedi. Sayfayı yenileyin."}
              </Alert>
            ) : null}
            <Field label="Portföy adı" htmlFor="portfolio-name">
              <input
                id="portfolio-name"
                className="control"
                maxLength={80}
                value={name}
                onChange={(event) => {
                  // Yazmaya başlayınca eski "kaydedildi"/hata bildirimi geçersizdir.
                  setName(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
                disabled={status !== "ready"}
              />
            </Field>

            {error ? <Alert tone="danger">{error}</Alert> : null}
            {saved ? <Alert tone="success">Ayarlarınız kaydedildi.</Alert> : null}

            <div className="flex justify-end">
              <button type="submit" className="btn btn-primary" disabled={busy || status !== "ready"}>
                {busy ? "Kaydediliyor…" : "Kaydet"}
              </button>
            </div>
          </form>
        </Card>
      </section>

      <section>
        <SectionTitle title="Hesabım" />
        <Card className="space-y-3 p-4">
          <div>
            <p className="text-xs text-subtle">Kullanıcı adı</p>
            <p className="text-sm font-medium text-ink">{user.username}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link href="/parola-degistir" className="btn btn-secondary">
              Parolamı değiştir
            </Link>
            {logoutAllOpen ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  data-testid="confirm-logout-all"
                  onClick={() => void logoutEverywhere()}
                  disabled={logoutAllBusy}
                >
                  {logoutAllBusy ? "Kapatılıyor…" : "Evet, tüm cihazlardan çık"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setLogoutAllOpen(false)}
                  disabled={logoutAllBusy}
                >
                  Vazgeç
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="open-logout-all"
                onClick={() => setLogoutAllOpen(true)}
              >
                Tüm cihazlardan çıkış yap
              </button>
            )}
          </div>

          {logoutAllError ? <Alert tone="danger">{logoutAllError}</Alert> : null}

          <p className="text-sm text-muted">“Çıkış” yalnızca bu cihazı kapatır.</p>
        </Card>
      </section>

      <section>
        <SectionTitle title="Verileriniz" />
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-secondary min-h-11" href="/api/portfolio/export?tur=islem" data-testid="export-ledger">
              İşlemleri CSV indir
            </a>
            <a
              className="btn btn-secondary min-h-11"
              href="/api/portfolio/export?tur=pozisyon"
              data-testid="export-positions"
            >
              Varlıklarımı CSV indir
            </a>
          </div>

          {deletionNotice ? <Alert tone="success">{deletionNotice}</Alert> : null}
          {deletionError ? <Alert tone="danger">{deletionError}</Alert> : null}

          {deletionOpen ? (
            <div className="space-y-3 rounded-[var(--radius-sm)] border border-negative-soft p-3.5">
              <p className="text-sm text-muted">
                Bu işlem geri alınamaz; silmeden önce CSV dosyalarınızı indirin.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  className="btn btn-secondary min-h-11"
                  onClick={() => setDeletionOpen(false)}
                  disabled={deletionBusy}
                >
                  Vazgeç
                </button>
                <button
                  type="button"
                  className="btn btn-danger min-h-11"
                  data-testid="confirm-deletion-request"
                  onClick={() => void requestDeletion()}
                  disabled={deletionBusy}
                >
                  {deletionBusy ? "Gönderiliyor…" : "Silme talebi gönder"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost min-h-11 text-negative"
              data-testid="open-deletion-request"
              onClick={() => setDeletionOpen(true)}
            >
              Hesap ve veri silme talebi
            </button>
          )}
        </Card>
      </section>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>
          {appConfig.name} {appConfig.version}
        </span>
        <Link className="underline" href="/gizlilik">
          Gizlilik ve KVKK
        </Link>
      </div>
    </div>
  );
}
