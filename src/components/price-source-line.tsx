"use client";

import { useCallback, useSyncExternalStore } from "react";

import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { isSnapshotStale, type PriceSnapshot } from "@/prices";
import { cx } from "./ui";

const SERVER_CLOCK = () => null;

/**
 * İstemci tarafında belirli aralıklarla ilerleyen saat.
 * Sunucuda null döner; böylece göreli zaman metni hidrasyonu bozmaz.
 */
function useClientClock(intervalMs: number): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, intervalMs);
      return () => clearInterval(timer);
    },
    [intervalMs],
  );
  const getSnapshot = useCallback(
    // Aralık içinde sabit değer döner; React sonsuz döngüye girmez.
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getSnapshot, SERVER_CLOCK);
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-line-strong">
      ·
    </span>
  );
}

/**
 * Fiyat kaynağı şeridi — tek satır, sayfanın altında.
 *
 * Ekranın ortasında yer kaplamaz ama ürün kuralı gereği şu bilgiler HER ZAMAN
 * görünür kalır: kaynağın adı, gerçek piyasa verisi olmadığı uyarısı, piyasa,
 * veri durumu ve son fiyat zamanı. Uzun yasal açıklama katlanmış durur.
 */
export function PriceSourceLine({
  snapshot,
  dataStatusLabel,
  isOnline,
  onRefresh,
  lastSyncedAt = null,
  syncStatus = "off",
}: {
  snapshot: PriceSnapshot | null;
  dataStatusLabel: string;
  isOnline: boolean;
  onRefresh?: () => void;
  /** Cihazlar arası son başarılı senkronizasyon (ms); sunucu deposunda dolar. */
  lastSyncedAt?: number | null;
  syncStatus?: "off" | "idle" | "syncing" | "paused" | "error";
}) {
  const now = useClientClock(30_000);
  const stale = snapshot && now !== null ? isSnapshotStale(snapshot, now) : false;
  const unavailable = !snapshot || snapshot.status === "unavailable";

  return (
    <div data-testid="price-source" className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-subtle">
        <span>Fiyat kaynağı:</span>
        <span className="font-semibold text-muted">{snapshot?.provider.label ?? "Bilinmiyor"}</span>

        {snapshot && !snapshot.provider.isRealMarketData ? (
          <span className="badge badge-notice">Gerçek piyasa verisi değil</span>
        ) : null}

        <Dot />
        <span>{snapshot?.provider.market ?? "—"}</span>
        <Dot />
        <span>{dataStatusLabel}</span>
        <Dot />
        <span
          className={cx(stale && "text-[var(--notice)]")}
          title={snapshot ? formatDateTime(snapshot.fetchedAt) : undefined}
        >
          Son fiyat:{" "}
          {snapshot && now !== null
            ? `${formatRelativeTime(snapshot.fetchedAt, now)}${stale ? " (bayat)" : ""}`
            : "—"}
        </span>

        {syncStatus !== "off" ? (
          <>
            <Dot />
            <span
              data-testid="sync-status"
              data-sync-status={syncStatus}
              className={cx(syncStatus === "error" && "text-[var(--notice)]")}
              title={lastSyncedAt ? formatDateTime(new Date(lastSyncedAt).toISOString()) : undefined}
            >
              Eşitleme:{" "}
              {lastSyncedAt && now !== null
                ? formatRelativeTime(new Date(lastSyncedAt).toISOString(), now)
                : syncStatus === "paused"
                  ? "duraklatıldı"
                  : "—"}
              {syncStatus === "error" ? " (yeniden denenecek)" : ""}
            </span>
          </>
        ) : null}

        {onRefresh ? (
          <button
            type="button"
            className="ml-auto rounded-[6px] px-2 py-1 font-semibold text-muted hover:bg-surface-3 hover:text-ink"
            onClick={onRefresh}
          >
            Yenile
          </button>
        ) : null}
      </div>

      {snapshot && !snapshot.provider.isRealMarketData ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-subtle hover:text-muted">
            Bu fiyatlar hakkında
          </summary>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {snapshot.provider.disclaimer}
          </p>
        </details>
      ) : null}

      {unavailable ? (
        <p className="mt-2 rounded-[var(--radius-sm)] bg-negative-soft px-3 py-2 text-xs font-medium text-negative">
          Fiyat kaynağına ulaşılamıyor. Başka bir piyasanın fiyatı gösterilmez; değerleme
          hesaplanmadı.
        </p>
      ) : null}

      {!isOnline ? (
        <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3 py-2 text-xs font-medium text-[var(--notice)]">
          Çevrimdışısınız. Kayıtlı portföyünüzü görüntülüyorsunuz; canlı fiyat akışı yoktur.
        </p>
      ) : null}
    </div>
  );
}
