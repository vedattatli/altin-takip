"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { Alert, Card, SectionTitle, cx } from "../ui";

/**
 * Yönetici — Fiyat Kaynakları.
 *
 * Lisans durumu, kapsam, sağlık ve son alım koşumu tek ekranda görünür.
 * Lisanssız veya yapılandırılmamış kaynak ETKİNLEŞTİRİLEMEZ (sunucu da reddeder).
 * Bu ekranda API anahtarı veya secret GÖSTERİLMEZ; yalnızca eksik değişken ADLARI.
 */

export interface AdminProviderRow {
  code: string;
  displayName: string;
  technicalName: string;
  marketId: string;
  marketDisplayName: string;
  providerType: string;
  enabled: boolean;
  userSelectable: boolean;
  licenseStatus: string;
  licenseReference: string | null;
  redistributionAllowed: boolean;
  capabilities: string[];
  attribution: string;
  referenceUrl: string | null;
  coverage: number;
  mappingCount: number;
  health: {
    status: string;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    coverageCount: number;
    staleCount: number;
    quarantinedCount: number;
    latencyMs: number | null;
    safeErrorCode: string | null;
  } | null;
  lastRun: {
    status: string;
    startedAt: string;
    completedAt: string | null;
    quoteCount: number;
    rejectedCount: number;
    latencyMs: number | null;
    safeErrorCode: string | null;
  } | null;
  runtimeLicenseStatus: string;
  selectable: boolean;
  blockedReason: string | null;
  missingConfig: string[];
}

const LICENSE_LABELS: Record<string, string> = {
  LICENSED: "Lisanslı",
  LICENSE_REQUIRED: "Lisans bekleniyor",
  NOT_CONFIGURED: "Yapılandırılmadı",
  DEV_ONLY: "Yalnızca geliştirme",
};

const HEALTH_LABELS: Record<string, string> = {
  ok: "Çalışıyor",
  degraded: "Kısmi",
  unavailable: "Ulaşılamıyor",
  not_configured: "Yapılandırılmadı",
  license_required: "Lisans bekleniyor",
};

export function AdminPriceSourcesView({ initialProviders }: { initialProviders: AdminProviderRow[] }) {
  const [providers, setProviders] = useState(initialProviders);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setProviders(await apiFetch<AdminProviderRow[]>("/api/admin/price-sources"));
  }

  async function run(code: string, action: () => Promise<string>) {
    setBusy(code);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "İşlem tamamlanamadı.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Fiyat kaynakları"
        description="Kaynakların lisans durumu, kapsamı ve sağlığı. Lisanssız kaynak etkinleştirilemez ve kullanıcıya sunulmaz."
      />

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <ul className="space-y-3" data-testid="admin-price-sources">
        {providers.map((provider) => (
          <Card key={provider.code} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold text-ink">{provider.displayName}</p>
                  <span
                    className={cx(
                      "badge",
                      provider.licenseStatus === "LICENSED"
                        ? "badge-positive"
                        : provider.licenseStatus === "DEV_ONLY"
                          ? "badge-notice"
                          : "badge-negative",
                    )}
                  >
                    {LICENSE_LABELS[provider.licenseStatus] ?? provider.licenseStatus}
                  </span>
                  {provider.enabled ? <span className="badge badge-positive">Etkin</span> : null}
                  {provider.userSelectable ? <span className="badge">Kullanıcıya açık</span> : null}
                  {provider.capabilities.includes("REFERENCE_ONLY") ? (
                    <span className="badge badge-notice">Yalnızca referans</span>
                  ) : null}
                </div>
                <p className="mt-0.5 break-words text-xs text-muted">
                  {provider.technicalName} · {provider.marketDisplayName} · {provider.providerType}
                </p>
                <p className="tabular mt-1 text-xs text-subtle">
                  Kapsam: {provider.coverage} ürün · Eşleme: {provider.mappingCount} sembol
                  {provider.health ? ` · Sağlık: ${HEALTH_LABELS[provider.health.status] ?? provider.health.status}` : ""}
                  {provider.health?.lastSuccessAt
                    ? ` · Son başarılı: ${formatDateTime(provider.health.lastSuccessAt)}`
                    : ""}
                </p>
                {provider.lastRun ? (
                  <p className="tabular mt-0.5 text-xs text-subtle">
                    Son koşum: {provider.lastRun.status} · {provider.lastRun.quoteCount} fiyat ·{" "}
                    {provider.lastRun.rejectedCount} karantina
                    {provider.lastRun.safeErrorCode ? ` · ${provider.lastRun.safeErrorCode}` : ""}
                  </p>
                ) : null}
                {provider.missingConfig.length > 0 ? (
                  // Değişken adları uzun ve bölünmeyen tek kelimelerdir (ör.
                  // SARRAFPRO_REDISTRIBUTION_ALLOWED); 390 px'te taşmaması için kırılır.
                  <p className="mt-1 break-words text-xs text-[var(--notice)]">
                    Eksik ayar: {provider.missingConfig.join(", ")}
                  </p>
                ) : null}
                {provider.blockedReason ? (
                  <p className="mt-1 break-words text-xs text-[var(--notice)]">{provider.blockedReason}</p>
                ) : null}
                <p className="mt-1 max-w-prose break-words text-xs text-subtle">{provider.attribution}</p>
                {provider.referenceUrl ? (
                  <a
                    className="mt-1 inline-block text-xs text-accent underline"
                    href={provider.referenceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Kaynağın resmî sayfası
                  </a>
                ) : null}
              </div>

              {/* shrink-0 mobilde max-content genişlik dayatıp yatay taşma üretiyordu;
                  dar ekranda kendi satırını alır ve düğmeler içeride sarar. */}
              <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  disabled={busy !== null}
                  data-testid={`test-${provider.code}`}
                  onClick={() =>
                    void run(provider.code, async () => {
                      const health = await apiFetch<{ status: string; message: string }>(
                        `/api/admin/price-sources/${provider.code}/test`,
                        { method: "POST" },
                      );
                      return `${provider.displayName}: ${health.message}`;
                    })
                  }
                >
                  Bağlantıyı test et
                </button>
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  disabled={busy !== null || !provider.enabled}
                  data-testid={`refresh-${provider.code}`}
                  onClick={() =>
                    void run(provider.code, async () => {
                      const result = await apiFetch<{ message: string }>(
                        `/api/admin/price-sources/${provider.code}/refresh`,
                        { method: "POST" },
                      );
                      return `${provider.displayName}: ${result.message}`;
                    })
                  }
                >
                  Şimdi güncelle
                </button>
                <button
                  type="button"
                  className={cx("btn min-h-9 px-2.5 py-1 text-xs", provider.enabled ? "btn-secondary" : "btn-primary")}
                  disabled={busy !== null || (!provider.enabled && !provider.selectable)}
                  data-testid={`toggle-${provider.code}`}
                  onClick={() =>
                    void run(provider.code, async () => {
                      await apiFetch(`/api/admin/price-sources/${provider.code}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          enabled: !provider.enabled,
                          userSelectable: !provider.enabled ? provider.userSelectable : false,
                        }),
                      });
                      return provider.enabled
                        ? `${provider.displayName} kapatıldı.`
                        : `${provider.displayName} etkinleştirildi.`;
                    })
                  }
                >
                  {provider.enabled ? "Kapat" : "Etkinleştir"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  disabled={busy !== null || !provider.enabled}
                  data-testid={`selectable-${provider.code}`}
                  onClick={() =>
                    void run(provider.code, async () => {
                      await apiFetch(`/api/admin/price-sources/${provider.code}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: true, userSelectable: !provider.userSelectable }),
                      });
                      return provider.userSelectable
                        ? `${provider.displayName} kullanıcı seçimine kapatıldı.`
                        : `${provider.displayName} kullanıcı seçimine açıldı.`;
                    })
                  }
                >
                  {provider.userSelectable ? "Kullanıcıya kapat" : "Kullanıcıya aç"}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </ul>
    </div>
  );
}
