"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDateTime } from "@/lib/format";
import type { KayseriSnapshot } from "./kayseri-prices-view";
import { cx } from "./ui";

/**
 * KAYSERİ CANLI ALTIN EKRANI — KOMPAKT PANEL
 *
 * İKİ AYRI ZAMAN, BİLEREK AYRI GÖSTERİLİR:
 *
 *  1. Ekran gözlemi   — toplayıcının Sarraf TV ekranını en son okuduğu an.
 *  2. Canlı pencere   — tv.sarraf.pro kendi kendini sürekli günceller.
 *
 * Canlı pencere, portföy hesabından DAHA YENİ bir fiyat gösteriyor olabilir;
 * çünkü hesap saatte bir toplanan doğrulanmış gözlemi kullanır. Bu fark
 * gizlenmez, panelin altında açıkça yazılır. Eski bir gözlem hiçbir koşulda
 * "anlık" diye etiketlenmez.
 *
 * Canlı pencere VARSAYILAN OLARAK YÜKLENMEZ: üçüncü taraf bir sayfa, kullanıcı
 * istemeden portföy ekranında çalışmaz. Kullanıcı açtığında `sandbox` ile
 * sınırlandırılmış, `referrerpolicy="no-referrer"` ile kimliksiz yüklenir ve
 * üst pencereyi yönlendiremez.
 */

/** Panelde gösterilen dört ürün ve ekrandaki karşılıkları. */
const PANEL_PRODUCTS: readonly { productId: string; label: string; rawLabels: readonly string[] }[] = [
  { productId: "yeni-ceyrek", label: "Çeyrek", rawLabels: ["ÇEYREK"] },
  { productId: "yeni-yarim", label: "Yarım", rawLabels: ["YARIM"] },
  { productId: "yeni-tam", label: "Tam Altın", rawLabels: ["TAM ALTIN", "TAM"] },
  { productId: "gremse-altin", label: "Gremse", rawLabels: ["GREMSE"] },
];

export const SARRAF_TV_URL = "https://tv.sarraf.pro/?code=383838&mode=frame&slug=kayseri";

function money(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StatusBadge({ snapshot }: { snapshot: KayseriSnapshot }) {
  const { freshness, ageMinutes } = snapshot;
  if (freshness === "none") {
    return <span className="badge">Gözlem yok</span>;
  }
  const label = freshness === "fresh" ? "Güncel" : freshness === "stale" ? "Bayat" : "Kullanılamıyor";
  return (
    <span
      className={cx("badge", freshness === "fresh" ? "badge-positive" : freshness === "stale" ? "badge-notice" : "badge-negative")}
      data-testid="panel-freshness"
    >
      {label}
      {ageMinutes === null ? "" : ` · ${String(ageMinutes)} dk`}
    </span>
  );
}

function PriceTable({ snapshot }: { snapshot: KayseriSnapshot }) {
  const rows = PANEL_PRODUCTS.map((entry) => {
    const row =
      snapshot.rows.find((candidate) => candidate.canonicalProductId === entry.productId) ??
      snapshot.rows.find((candidate) =>
        entry.rawLabels.includes(candidate.rawLabel.trim().toLocaleUpperCase("tr-TR")),
      ) ??
      null;
    return { ...entry, row };
  });

  return (
    <table className="w-full text-xs" data-testid="panel-price-table">
      <thead>
        <tr className="text-subtle">
          <th className="pb-1 text-left font-medium">Ürün</th>
          <th className="pb-1 text-right font-medium">Bozdurma</th>
          <th className="pb-1 text-right font-medium">Yeniden alım</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ productId, label, row }) => (
          <tr key={productId} className="border-t border-line" data-testid={`panel-row-${productId}`}>
            <td className="py-1.5 pr-1 font-medium text-ink">{label}</td>
            <td className="tabular py-1.5 text-right text-ink">{money(row?.buy ?? null)}</td>
            <td className="tabular py-1.5 text-right text-muted">{money(row?.sell ?? null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function KayseriLivePanel({ snapshot }: { snapshot: KayseriSnapshot }) {
  // Mobilde varsayılan kapalı; masaüstünde CSS ile her zaman açık.
  const [openOnMobile, setOpenOnMobile] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);

  if (!snapshot.allowed) return null;

  const observedText = snapshot.observedAt ? formatDateTime(snapshot.observedAt) : "—";

  return (
    <aside className="live-panel" aria-label="Kayseri canlı altın ekranı" data-testid="kayseri-live-panel">
      <div className="card live-panel-card">
        <button
          type="button"
          className="live-panel-head"
          aria-expanded={openOnMobile}
          aria-controls="live-panel-body"
          onClick={() => setOpenOnMobile((value) => !value)}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">Kayseri Canlı Altın Ekranı</span>
            <span className="block truncate text-xs text-muted">Sarraf TV Kayseri</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusBadge snapshot={snapshot} />
            <span aria-hidden="true" className="live-panel-chevron text-subtle">
              ▾
            </span>
          </span>
        </button>

        <div id="live-panel-body" className={cx("live-panel-body", openOnMobile && "is-open")}>
          <div className="live-panel-scroll">
            <PriceTable snapshot={snapshot} />

            {liveOpen ? (
              <div className="mt-3">
                <iframe
                  title="Sarraf TV Kayseri canlı ekranı"
                  src={SARRAF_TV_URL}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  /*
                   * `allow-same-origin` framelenen sayfaya KENDİ origin'ini
                   * geri verir; bizim origin'imizi vermez. Üst pencereyi
                   * yönlendirme, form gönderme ve açılır pencere izinleri
                   * bilinçli olarak VERİLMEZ.
                   */
                  sandbox="allow-scripts allow-same-origin"
                  className="h-[190px] w-full rounded-[var(--radius-sm)] border border-line bg-black"
                />
                <p className="mt-1 text-[0.6875rem] leading-snug text-subtle">
                  Bu pencere kaynağın kendi canlı ekranıdır ve portföy hesabının veri kaynağı değildir.
                </p>
              </div>
            ) : null}
          </div>

          <div className="live-panel-foot">
            <p className="tabular text-[0.6875rem] leading-snug text-subtle" data-testid="panel-observed-at">
              Portföy hesabında kullanılan son doğrulanmış gözlem: {observedText}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <button
                type="button"
                className="text-accent underline"
                onClick={() => setLiveOpen((value) => !value)}
              >
                {liveOpen ? "Canlı ekranı gizle" : "Canlı ekranı göster"}
              </button>
              <Link className="text-accent underline" href="/kayseri-fiyatlari">
                Tam ekran aç
              </Link>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
