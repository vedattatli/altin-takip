"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SessionUser } from "@/auth/types";
import { ROLE_LABELS } from "@/auth/types";
import { appConfig } from "@/config/app.config";
import { apiFetch } from "@/lib/api-client";
import { usePortfolio } from "@/state/portfolio-store";
import { Alert, Card, Field, SectionTitle } from "./ui";

export function SettingsView({ user }: { user: SessionUser | null }) {
  const router = useRouter();
  const { portfolio, repository, renamePortfolio, status } = usePortfolio();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [logoutAllBusy, setLogoutAllBusy] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionReason, setDeletionReason] = useState("");
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
        body: JSON.stringify({ reason: deletionReason.trim() }),
      });
      setDeletionNotice(result.message);
      setDeletionOpen(false);
      setDeletionReason("");
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
    setDisplayName(portfolio.displayName);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await renamePortfolio({ name: name.trim() || "Portföyüm", displayName: displayName.trim() });
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
        <SectionTitle title="Portföy" description="Portföyünüzü kendinize göre adlandırın." />
        <Card className="p-4 sm:p-5">
          <form className="space-y-4" onSubmit={handleSave} noValidate>
            <Field label="Portföy adı" htmlFor="portfolio-name">
              <input
                id="portfolio-name"
                className="control"
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={status !== "ready"}
              />
            </Field>
            <Field
              label="Görünen ad"
              htmlFor="portfolio-display-name"
              hint="Panelde selamlama ve raporlarda kullanılır. İsteğe bağlı."
            >
              <input
                id="portfolio-display-name"
                className="control"
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
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

      {user ? (
        <section>
          <SectionTitle title="Hesap" />
          <Card className="divide-y divide-[var(--line)]">
            <dl className="grid grid-cols-1 gap-y-3 p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-subtle">Kullanıcı adı</dt>
                <dd className="text-sm font-medium text-ink">{user.username}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Görünen ad</dt>
                <dd className="text-sm font-medium text-ink">{user.displayName}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Rol</dt>
                <dd className="text-sm font-medium text-ink">{ROLE_LABELS[user.role]}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Veri saklama</dt>
                <dd className="text-sm font-medium text-ink">
                  {repository.label}
                  {repository.syncsAcrossDevices
                    ? " · cihazlar arasında senkron"
                    : " · yalnızca bu cihaz"}
                </dd>
              </div>
            </dl>
            <div className="p-4">
              <Link href="/parola-degistir" className="btn btn-secondary">
                Parolamı değiştir
              </Link>
            </div>
          </Card>
        </section>
      ) : null}

      {user ? (
        <section>
          <SectionTitle
            title="Oturumlar"
            description="Her cihazda bir kez giriş yaparsınız; oturum siz çıkış yapana kadar açık kalır."
          />
          <Card className="space-y-3 p-4">
            <p className="text-sm text-muted">
              Normal “Çıkış” yalnızca bu cihazı kapatır. Telefon, tablet ve bilgisayardaki tüm
              oturumları aynı anda kapatmak için aşağıdaki seçeneği kullanın.
            </p>
            {logoutAllError ? <Alert tone="danger">{logoutAllError}</Alert> : null}
            {logoutAllOpen ? (
              <div className="flex flex-wrap items-center gap-2">
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
              </div>
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
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle
          title="Verileriniz"
          description="Uygulamaya kaydettiğiniz altın portföyünü dışa aktarabilir veya silinmesini talep edebilirsiniz."
        />
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
              Pozisyonları CSV indir
            </a>
            <Link className="btn btn-secondary min-h-11" href="/gizlilik">
              Gizlilik ve KVKK
            </Link>
          </div>

          {deletionNotice ? <Alert tone="success">{deletionNotice}</Alert> : null}
          {deletionError ? <Alert tone="danger">{deletionError}</Alert> : null}

          {deletionOpen ? (
            <div className="space-y-3 rounded-[var(--radius-sm)] border border-negative-soft p-3.5">
              <p className="text-sm text-muted">
                Hesabınız ve uygulamaya kaydettiğiniz portföy verisi yönetici onayıyla kalıcı olarak silinir.
                Silmeden önce verilerinizi CSV olarak indirmeniz önerilir.
              </p>
              <Field label="Sebep (isteğe bağlı)" htmlFor="deletion-reason">
                <input
                  id="deletion-reason"
                  className="control min-h-11"
                  maxLength={500}
                  value={deletionReason}
                  onChange={(event) => setDeletionReason(event.target.value)}
                />
              </Field>
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

      <section>
        <SectionTitle title="Uygulama" />
        <Card className="p-4 text-sm text-muted">
          <p>
            <span className="font-medium text-ink">{appConfig.name}</span> sürüm{" "}
            {appConfig.version}
          </p>
          <p className="mt-2 leading-relaxed">
            Fiyat kaynağınızı <Link className="text-accent underline" href="/fiyat-kaynagi">Fiyat kaynağı</Link>{" "}
            ekranından görebilir ve yöneticinin açtığı kaynaklar arasında değiştirebilirsiniz. Lisanssız
            kaynaklar gerçek veri olarak kullanılmaz; test verisi her zaman açıkça etiketlenir.
          </p>
          <p className="mt-2 leading-relaxed">
            Gösterilen fiyatlar bilgilendirme amaçlıdır ve bağlayıcı bir alım satım teklifi değildir.
          </p>
        </Card>
      </section>
    </div>
  );
}
