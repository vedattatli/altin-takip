"use client";

import { useState } from "react";

import { getProduct } from "@/domain/catalog";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { sourceBadgeFor } from "@/prices/valuation-plan";
import { Alert, Card, Explain, SectionTitle, cx } from "../ui";

/**
 * Yönetici — Fiyat Kaynakları.
 *
 * Ekran tek soruyu yanıtlar: fiyat geliyor mu, gelmiyorsa hangi kaynaktan.
 * En üstte tek satırlık durum özeti, altında yalnızca BAĞLI kaynakların
 * kartları durur.
 *
 * Bağlanmamış kaynaklar (kurulmamış, lisans bekleyen, yalnızca referans)
 * kapalı bir listeye iner. Bu YALNIZCA arayüz filtresidir; kaynaklar kodda
 * ve API'de olduğu gibi kalır, etkinleştirme kapısı (`canEnable` + sunucu
 * kısıtı) yerindedir.
 *
 * Bu ekranda API anahtarı, secret veya ortam değişkeni ADI gösterilmez.
 */

export interface AdminProviderRow {
  code: string;
  displayName: string;
  technicalName: string;
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
  capabilities: string[];
  attribution: string;
  referenceUrl: string | null;
  coverage: number;
  mappingCount: number;
  health: {
    status: string;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
  } | null;
  lastRun: {
    status: string;
    quoteCount: number;
    rejectedCount: number;
    safeErrorCode: string | null;
  } | null;
  blockedReason: string | null;
  missingConfig: string[];
  /** Açık global varsayılan kaynak mı? */
  isDefault: boolean;
  /** Sağlayıcının sunduğunu söylediği ama bizde adapter'ı OLMAYAN yetenekler. */
  advertisedCapabilities: string[];
}

/** Karantina satırı (salt okunur). */
export interface AdminQuarantineRow {
  providerCode: string;
  canonicalProductId: string;
  rejectionCode: string;
  liquidationPrice: string | null;
  replacementPrice: string | null;
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

/**
 * Lisans rozeti metinleri.
 *
 * `EXPERIMENTAL_PRIVATE` de burada olmak ZORUNDA: uygulamanın fiyat üreten
 * kaynaklarının hepsi bu durumdadır ve sözlükte karşılığı yokken ekrana ham
 * İngilizce sabit basılıyordu. Rozet silinemez — lisanssız kaynak arayüzde
 * lisanssız etiketlenir.
 */
const LICENSE_LABELS: Record<string, string> = {
  LICENSED: "Lisanslı",
  LICENSE_REQUIRED: "Lisans bekleniyor",
  NOT_CONFIGURED: "Yapılandırılmadı",
  DEV_ONLY: "Yalnızca geliştirme",
  EXPERIMENTAL_PRIVATE: "Lisanssız",
};

/** Alım koşumu sonucu — veritabanı sabitleri ham İngilizce gelir. */
const RUN_LABELS: Record<string, string> = {
  RUNNING: "Sürüyor",
  SUCCESS: "Başarılı",
  PARTIAL: "Kısmi",
  FAILED: "Başarısız",
  SKIPPED: "Atlandı",
};

/**
 * Kart başlığı ve mesajlarda kullanılan ad.
 *
 * `displayName` piyasa adıdır ve iki kaynakta birden aynı olabilir ("Kayseri
 * Yerel Piyasa" x2). Kullanıcı ekranındaki rozet adı hem ayırt eder hem de
 * iki ekranın aynı kaynağı aynı adla anmasını sağlar.
 */
function providerLabel(provider: AdminProviderRow): string {
  return sourceBadgeFor(provider.code)?.label ?? provider.displayName;
}

/**
 * "Bağlı kaynak" = sistemin gerçekten fiyat çektiği ya da yöneticinin açtığı
 * kaynak. Yalnızca bunlar kart olarak çizilir; geri kalanı kapalı listeye iner.
 */
function isConnected(provider: AdminProviderRow): boolean {
  return provider.enabled || provider.coverage > 0 || provider.lastRun !== null;
}

/** Bağlanmamış kaynağın tek cümlelik sebebi. */
function disconnectedReason(provider: AdminProviderRow): string {
  return provider.blockedReason ?? "Kapalı; bu kaynaktan fiyat alınmıyor.";
}

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

  const connected = providers.filter(isConnected);
  const disconnected = providers.filter((provider) => !isConnected(provider));

  // Durum özeti: açık ama veri getirmeyen kaynak "fiyat gelmiyor" demektir.
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const silentProviders = enabledProviders.filter(
    (provider) => provider.coverage === 0 || !provider.health?.lastSuccessAt,
  );
  let lastSuccessAt: string | null = null;
  for (const provider of enabledProviders) {
    const at = provider.health?.lastSuccessAt;
    if (!at) continue;
    if (!lastSuccessAt || Date.parse(at) > Date.parse(lastSuccessAt)) lastSuccessAt = at;
  }

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
        description="Fiyatların hangi kaynaktan geldiği ve en son ne zaman güncellendiği."
      />

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {enabledProviders.length === 0 ? (
        <Alert tone="danger">Hiçbir fiyat kaynağı açık değil; fiyat gelmiyor.</Alert>
      ) : silentProviders.length > 0 ? (
        <Alert tone="notice">
          {silentProviders.length} kaynaktan fiyat gelmiyor:{" "}
          {silentProviders.map(providerLabel).join(", ")}.
        </Alert>
      ) : (
        <Alert tone="success">
          Fiyat kaynakları çalışıyor.
          {lastSuccessAt ? ` Son güncelleme ${formatDateTime(lastSuccessAt)}.` : ""}
        </Alert>
      )}

      <ul className="space-y-3" data-testid="admin-price-sources">
        {connected.length === 0 ? (
          <li className="text-sm text-muted">Bağlı fiyat kaynağı yok.</li>
        ) : null}
        {connected.map((provider) => (
          <Card key={provider.code} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold text-ink">{providerLabel(provider)}</p>
                  <span
                    className={cx(
                      "badge",
                      provider.licenseStatus === "LICENSED"
                        ? "badge-positive"
                        : provider.licenseStatus === "DEV_ONLY" ||
                            provider.licenseStatus === "EXPERIMENTAL_PRIVATE"
                          ? "badge-notice"
                          : "badge-negative",
                    )}
                  >
                    {LICENSE_LABELS[provider.licenseStatus] ?? provider.licenseStatus}
                  </span>
                  {provider.enabled ? <span className="badge badge-positive">Etkin</span> : null}
                </div>
                <p className="mt-0.5 break-words text-xs text-muted">{provider.technicalName}</p>
                <p className="tabular mt-1 text-xs text-subtle">
                  {provider.coverage} üründe fiyat
                  {provider.health?.lastSuccessAt
                    ? ` · Son güncelleme ${formatDateTime(provider.health.lastSuccessAt)}`
                    : ""}
                </p>
                {provider.lastRun ? (
                  <p className="tabular mt-0.5 text-xs text-subtle">
                    Son alım: {RUN_LABELS[provider.lastRun.status] ?? provider.lastRun.status} ·{" "}
                    {provider.lastRun.quoteCount} fiyat alındı · {provider.lastRun.rejectedCount}{" "}
                    fiyat reddedildi
                  </p>
                ) : null}
                {/* Ortam değişkeni ADLARI ekrana yazılmaz; sahibinin okuyacağı tek
                    şey kaynağın neden fiyat alamadığıdır. blockedReason varsa aynı
                    cümle iki kez yazılmasın diye yalnızca o gösterilir. */}
                {provider.missingConfig.length > 0 && !provider.blockedReason ? (
                  <p className="mt-1 text-xs text-[var(--notice)]">
                    Bu kaynak kurulmadığı için fiyat alamıyor.
                  </p>
                ) : null}
                {provider.blockedReason ? (
                  <p className="mt-1 break-words text-xs text-[var(--notice)]">{provider.blockedReason}</p>
                ) : null}
                {/* Dürüst kaynak açıklaması SİLİNMEZ, yalnızca katlanır: bir kez
                    okunacak referans bilgisidir, her kartta açık durması gerekmez. */}
                <Explain title="Kaynak hakkında" className="mt-1.5">
                  <p className="max-w-prose break-words">{provider.attribution}</p>
                  {provider.referenceUrl ? (
                    <a
                      className="mt-1 inline-block text-accent underline"
                      href={provider.referenceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Kaynağın sayfası
                    </a>
                  ) : null}
                </Explain>
              </div>

              {/* shrink-0 mobilde max-content genişlik dayatıp yatay taşma üretiyordu;
                  dar ekranda kendi satırını alır ve düğmeler içeride sarar. */}
              <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
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
                      return `${providerLabel(provider)}: ${result.message}`;
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
                        ? `${providerLabel(provider)} kapatıldı.`
                        : `${providerLabel(provider)} etkinleştirildi.`;
                    })
                  }
                >
                  {provider.enabled ? "Kapat" : "Etkinleştir"}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </ul>

      {disconnected.length > 0 ? (
        <Card className="p-4" data-testid="disconnected-sources">
          {/* Kaynaklar koddan silinmez; yalnızca ekranı doldurmasınlar diye katlanır.
              Ad olarak technicalName kullanılır: displayName birkaç kaynakta aynıdır
              ve liste birbirinin kopyası satırlara dönerdi. */}
          <Explain title={`Bağlanmamış kaynaklar (${disconnected.length})`}>
            <ul className="space-y-1.5">
              {disconnected.map((provider) => (
                <li key={provider.code} className="break-words">
                  {provider.technicalName} — {disconnectedReason(provider)}
                </li>
              ))}
            </ul>
          </Explain>
        </Card>
      ) : null}

      <Card className="p-4" data-testid="quarantine-list">
        <p className="text-sm font-semibold text-ink">Reddedilen fiyatlar</p>
        <p className="mt-1 text-xs text-muted">Bu fiyatlar değerlemeye girmedi.</p>
        {quarantine.length === 0 ? (
          <p className="mt-2 text-xs text-subtle">Reddedilen fiyat yok.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">Zaman</th>
                  <th className="py-1 pr-3 font-medium">Kaynak</th>
                  <th className="py-1 pr-3 font-medium">Ürün</th>
                  <th className="py-1 pr-3 font-medium">Sebep</th>
                  <th className="py-1 pr-3 font-medium">Bozdurma</th>
                  <th className="py-1 pr-3 font-medium">Yeniden alım</th>
                </tr>
              </thead>
              <tbody className="text-muted">
                {quarantine.map((row, index) => (
                  <tr key={`${row.providerCode}-${row.canonicalProductId}-${row.createdAt}-${index}`}>
                    <td className="tabular py-1 pr-3">{formatDateTime(row.createdAt)}</td>
                    <td className="py-1 pr-3">
                      {sourceBadgeFor(row.providerCode)?.label ?? row.providerCode}
                    </td>
                    {/* requireProduct bilinmeyen kimlikte HATA fırlatır; tek eski kayıt
                        yüzünden yönetim tablosu çökmesin diye ham kimliğe düşülür. */}
                    <td className="py-1 pr-3">
                      {getProduct(row.canonicalProductId)?.name ?? row.canonicalProductId}
                    </td>
                    <td className="py-1 pr-3 text-[var(--notice)]">
                      {REJECTION_LABELS[row.rejectionCode] ?? row.rejectionCode}
                    </td>
                    <td className="tabular py-1 pr-3">
                      {row.liquidationPrice ? formatMoney(row.liquidationPrice) : "—"}
                    </td>
                    <td className="tabular py-1 pr-3">
                      {row.replacementPrice ? formatMoney(row.replacementPrice) : "—"}
                    </td>
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
