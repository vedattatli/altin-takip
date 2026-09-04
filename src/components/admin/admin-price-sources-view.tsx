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
  /**
   * "Sistem bu kaynaktan fiyat çekebilir mi" — `selectable` ("kullanıcı genel
   * listeden seçebilir mi") ile KARIŞTIRILMAMALIDIR. Deneysel kaynakta
   * `selectable` her zaman false'tur ama kaynak etkinleştirilebilir.
   */
  canEnable: boolean;
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
  /** Açık global varsayılan kaynak mı? */
  isDefault: boolean;
  /** Sağlayıcının sunduğunu söylediği ama bizde adapter'ı OLMAYAN yetenekler. */
  advertisedCapabilities: string[];
  requiresPersistentWorker: boolean;
}

/** Karantina satırı (salt okunur). */
export interface AdminQuarantineRow {
  providerCode: string;
  marketId: string;
  canonicalProductId: string;
  rejectionCode: string;
  liquidationPrice: string | null;
  replacementPrice: string | null;
  currency: string | null;
  providerTimestamp: string | null;
  fetchedAt: string | null;
  mappingVersion: string | null;
  createdAt: string;
}

const REJECTION_LABELS: Record<string, string> = {
  PRODUCT_UNKNOWN: "Bilinmeyen ürün",
  PRODUCT_MISMATCH: "Ürün uyuşmuyor",
  PROVIDER_MISMATCH: "Sağlayıcı uyuşmuyor",
  MARKET_MISMATCH: "Piyasa uyuşmuyor",
  PRICE_NOT_POSITIVE: "Fiyat pozitif değil",
  INVERTED_SPREAD: "Makas ters",
  SPREAD_TOO_WIDE: "Makas çok geniş",
  CURRENCY_NOT_TRY: "Para birimi TL değil",
  TIMESTAMP_INVALID: "Zaman geçersiz",
  TIMESTAMP_PROVENANCE_UNKNOWN: "Sağlayıcı zamanı bildirilmedi",
  TIMESTAMP_FUTURE: "Zaman gelecekte",
  STALE: "Bayat",
  FETCHED_BEFORE_PROVIDER: "Çekilme zamanı tutarsız",
  PRICE_JUMP: "Aşırı fiyat sıçraması",
  OUT_OF_RANGE: "Fiyat aralık dışı",
  STATUS_NOT_OK: "Sağlayıcı durumu uygun değil",
  DUPLICATE_CANONICAL_PRODUCT: "Aynı üründen iki kayıt",
};

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

export function AdminPriceSourcesView({
  initialProviders,
  initialQuarantine = [],
}: {
  initialProviders: AdminProviderRow[];
  initialQuarantine?: AdminQuarantineRow[];
}) {
  const [providers, setProviders] = useState(initialProviders);
  const [quarantine, setQuarantine] = useState(initialQuarantine);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaultProvider = providers.find((provider) => provider.isDefault) ?? null;

  async function reload() {
    const [rows, quarantineRows] = await Promise.all([
      apiFetch<AdminProviderRow[]>("/api/admin/price-sources"),
      apiFetch<AdminQuarantineRow[]>("/api/admin/price-sources/quarantine?limit=20").catch(() => []),
    ]);
    setProviders(rows);
    setQuarantine(quarantineRows);
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

      <Card className="p-4" data-testid="default-source">
        <p className="text-sm font-semibold text-ink">Global varsayılan kaynak</p>
        <p className="mt-1 text-xs text-muted">
          {defaultProvider
            ? `${defaultProvider.displayName} (${defaultProvider.marketDisplayName})`
            : "Tanımlı değil — kendi seçimini yapmamış kullanıcılara fiyat kaynağı ATANMAZ."}
        </p>
        <p className="mt-1 text-xs text-subtle">
          Kendi tercihini yapmış kullanıcılar bu değişiklikten etkilenmez.
        </p>
      </Card>

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
                  {provider.isDefault ? <span className="badge badge-positive">Global varsayılan</span> : null}
                  {provider.capabilities.includes("PROTOTYPE") ? (
                    <span className="badge badge-notice">Taslak adapter</span>
                  ) : null}
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
                {provider.advertisedCapabilities.length > 0 ? (
                  <p className="mt-1 break-words text-xs text-subtle">
                    Sağlayıcı ayrıca şunları sunduğunu bildiriyor ama bizde çalışan adapter YOK:{" "}
                    {provider.advertisedCapabilities.join(", ")}
                  </p>
                ) : null}
                {provider.requiresPersistentWorker ? (
                  <p className="mt-1 break-words text-xs text-subtle">
                    Bu kaynak kalıcı worker gerektirir (istek ömrü içinde bağlantı açılmaz).
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
                  disabled={busy !== null || (!provider.enabled && !provider.canEnable)}
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
                <button
                  type="button"
                  className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                  disabled={busy !== null || !provider.userSelectable || provider.isDefault}
                  data-testid={`default-${provider.code}`}
                  onClick={() =>
                    void run(provider.code, async () => {
                      await apiFetch("/api/admin/price-sources/default", {
                        method: "PUT",
                        body: JSON.stringify({ providerCode: provider.code }),
                      });
                      return `${provider.displayName} global varsayılan kaynak yapıldı.`;
                    })
                  }
                >
                  {provider.isDefault ? "Varsayılan" : "Varsayılan yap"}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </ul>

      <Card className="p-4" data-testid="quarantine-list">
        <p className="text-sm font-semibold text-ink">Son karantina kayıtları</p>
        <p className="mt-1 text-xs text-muted">
          Bu fiyatlar değerlemeye GİRMEDİ. Kayıtlar değiştirilemez; ham sağlayıcı yanıtı saklanmaz.
        </p>
        {quarantine.length === 0 ? (
          <p className="mt-2 text-xs text-subtle">Karantinaya alınmış kayıt yok.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">Zaman</th>
                  <th className="py-1 pr-3 font-medium">Kaynak</th>
                  <th className="py-1 pr-3 font-medium">Ürün</th>
                  <th className="py-1 pr-3 font-medium">Sebep</th>
                  <th className="py-1 pr-3 font-medium">Bozdurma</th>
                  <th className="py-1 pr-3 font-medium">Yeniden alım</th>
                  <th className="py-1 pr-3 font-medium">Eşleme</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {quarantine.map((row, index) => (
                  <tr key={`${row.providerCode}-${row.canonicalProductId}-${row.createdAt}-${index}`}>
                    <td className="tabular py-1 pr-3">{formatDateTime(row.createdAt)}</td>
                    <td className="py-1 pr-3">{row.providerCode}</td>
                    <td className="py-1 pr-3">{row.canonicalProductId}</td>
                    <td className="py-1 pr-3 text-[var(--notice)]">
                      {REJECTION_LABELS[row.rejectionCode] ?? row.rejectionCode}
                    </td>
                    <td className="tabular py-1 pr-3">{row.liquidationPrice ?? "—"}</td>
                    <td className="tabular py-1 pr-3">{row.replacementPrice ?? "—"}</td>
                    <td className="py-1 pr-3 break-words">{row.mappingVersion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
