"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDateTime } from "@/lib/format";
import type { KayseriSnapshot } from "./kayseri-prices-view";
import { cx } from "./ui";

/**
 * KAYSERİ ALTIN FİYATLARI — KOMPAKT PANEL
 *
 * Panelde yazan zaman, toplayıcının Sarraf TV ekranını en son okuduğu andır;
 * portföy hesabı da saatte bir toplanan bu doğrulanmış gözlemi kullanır.
 * Gözlemin yaşı gizlenmez: tazelik rozeti ve güncelleme saati panelde açıkça
 * yazılır, eski bir gözlem hiçbir koşulda "anlık" diye etiketlenmez.
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
    return <span className="badge">Fiyat yok</span>;
  }
  const label = freshness === "fresh" ? "Güncel" : freshness === "stale" ? "Eski" : "Kullanılamıyor";
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
    /*
     * Yalnızca DEĞERLEMEYE GİREN satır gösterilir. Ekranda okunan bir satır,
     * eşleme onaylanmadığı sürece portföy hesabına girmez; onu burada fiyatmış
     * gibi basmak, panelin "portföyün kullandığı fiyat" iddiasını yalanlar.
     * Değerlemeye girmeyen ham satırlar /kayseri-fiyatlari referans tablosunda
     * görünmeye devam eder.
     */
    return { ...entry, row: row && row.usedInValuation ? row : null };
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

  if (!snapshot.allowed) return null;

  const observedText = snapshot.observedAt ? formatDateTime(snapshot.observedAt) : "—";

  return (
    <aside className="live-panel" aria-label="Kayseri altın fiyatları" data-testid="kayseri-live-panel">
      <div className="card live-panel-card">
        <button
          type="button"
          className="live-panel-head"
          aria-expanded={openOnMobile}
          aria-controls="live-panel-body"
          onClick={() => setOpenOnMobile((value) => !value)}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">Kayseri Altın Fiyatları</span>
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
          </div>

          <div className="live-panel-foot">
            <p className="tabular text-[0.6875rem] leading-snug text-subtle" data-testid="panel-observed-at">
              Son güncelleme: {observedText}
            </p>
            <div className="mt-1.5 text-xs">
              <Link className="text-accent underline" href="/kayseri-fiyatlari">
                Tüm Kayseri fiyatları
              </Link>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
