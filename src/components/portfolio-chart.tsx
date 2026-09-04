"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import { usePortfolio } from "@/state/portfolio-store";
import { Card, cx } from "./ui";

/**
 * PORTFÖY DEĞERİ GRAFİĞİ
 *
 * ÇÖZÜNÜRLÜK KAYNAĞIN SIKLIĞIDIR. Fiyat ne sıklıkta toplanıyorsa grafik o
 * sıklıkta kırılır. Noktaların arası doldurulmaz, yumuşatılmaz; "1 dakikalık
 * mum" gibi olmayan bir çözünürlük üretilmez. Kaç dakikada bir veri geldiği
 * grafiğin altında AÇIKÇA yazar.
 *
 * Kütüphane kullanılmaz: çizgi satır içi SVG'dir. Tek bir çizgi ve birkaç
 * eksen etiketi için paket eklemek gereksiz bağımlılıktır.
 */

const RANGES = [
  { id: "1h", label: "1 saat" },
  { id: "24h", label: "24 saat" },
  { id: "7d", label: "7 gün" },
  { id: "30d", label: "30 gün" },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

interface HistoryPoint {
  at: string;
  liquidationValue: string;
  pricedProducts: number;
  missingProducts: number;
}

interface HistoryResponse {
  range: string;
  points: HistoryPoint[];
  medianStepMs: number | null;
  empty: boolean;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 180;
const PADDING_X = 8;
const PADDING_Y = 12;

function describeStep(ms: number | null): string {
  if (ms === null) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Veri saniyeler arayla geliyor.";
  if (minutes === 1) return "Veri yaklaşık dakikada bir geliyor.";
  if (minutes < 60) return `Veri yaklaşık ${String(minutes)} dakikada bir geliyor.`;
  const hours = Math.round(minutes / 60);
  return `Veri yaklaşık ${String(hours)} saatte bir geliyor.`;
}

function formatTick(iso: string, range: RangeId): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });
  if (range === "1h" || range === "24h") return time;
  const day = date.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Istanbul" });
  return day;
}

export function PortfolioChart() {
  const { summary } = usePortfolio();
  const [range, setRange] = useState<RangeId>("24h");

  /*
   * GRAFİK YENİ FİYAT GELİNCE KENDİLİĞİNDEN YENİLENİR.
   *
   * Ayrı bir zamanlayıcı KURULMAZ: portföy deposu fiyatları zaten periyodik
   * tazeliyor. Yeni bir anlık görüntü geldiğinde `fetchedAt` değişir ve grafik
   * o anda yeniden çekilir. Böylece grafik, fiyatın gerçekten güncellendiği
   * anda güncellenir — ne daha erken (boşuna istek) ne daha geç (bayat çizgi).
   */
  const snapshotAt = summary.snapshot?.fetchedAt ?? null;
  /*
   * Sonuç, HANGİ aralığa ait olduğuyla birlikte tutulur. Yükleme durumu bundan
   * TÜRETİLİR; effect içinde senkron setState yapılmaz (React "cascading
   * renders" uyarısı). Aralık değişince eski aralığın verisi anında "eski"
   * sayılır ve yanlış aralığın grafiği bir an bile gösterilmez.
   */
  const [result, setResult] = useState<{
    range: RangeId;
    data: HistoryResponse | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<HistoryResponse>(`/api/portfolio/history?range=${range}`)
      .then((response) => {
        if (!cancelled) setResult({ range, data: response, error: null });
      })
      .catch(() => {
        if (!cancelled) setResult({ range, data: null, error: "Grafik verisi alınamadı." });
      });
    return () => {
      cancelled = true;
    };
  }, [range, snapshotAt]);

  /*
   * Yenileme sırasında ESKİ grafik ekranda kalır: aynı aralığın verisi
   * duruyorsa "yükleniyor" yazısına düşmek, saniyede bir grafiğin kaybolup
   * gelmesi demek olurdu. Yalnızca aralık değişince veya ilk açılışta beklenir.
   */
  const busy = result === null || result.range !== range;
  const data = busy ? null : result.data;
  const error = busy ? null : result.error;

  const points = data?.points ?? [];
  const values = points.map((point) => Number(point.liquidationValue));
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  // Düz çizgide bölme hatası olmasın; tek nokta da çizilebilsin.
  const span = max - min || Math.max(max, 1) * 0.01;

  const coords = points.map((point, index) => {
    const x =
      points.length === 1
        ? VIEW_WIDTH / 2
        : PADDING_X + (index / (points.length - 1)) * (VIEW_WIDTH - PADDING_X * 2);
    const value = Number(point.liquidationValue);
    const y = VIEW_HEIGHT - PADDING_Y - ((value - min) / span) * (VIEW_HEIGHT - PADDING_Y * 2);
    return { x, y, point };
  });

  const line = coords.map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)} ${coord.y.toFixed(1)}`).join(" ");
  const area =
    coords.length > 0
      ? `${line} L${coords[coords.length - 1]!.x.toFixed(1)} ${VIEW_HEIGHT} L${coords[0]!.x.toFixed(1)} ${VIEW_HEIGHT} Z`
      : "";

  const first = values[0];
  const last = values[values.length - 1];
  const change = first !== undefined && last !== undefined ? last - first : null;
  const changePct = change !== null && first ? (change / first) * 100 : null;
  const partial = points.some((point) => point.missingProducts > 0);

  return (
    <Card className="p-4" data-testid="portfolio-chart">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">Portföy değeri</p>
          <p className="mt-0.5 text-xs text-muted">Bozdurma değerinin zaman içindeki seyri</p>
        </div>
        {change !== null && changePct !== null ? (
          <p
            className={cx("tabular text-sm font-semibold", change >= 0 ? "text-positive" : "text-negative")}
            data-testid="chart-change"
          >
            {change >= 0 ? "+" : "−"}
            {formatMoney(Math.abs(change).toFixed(2))} ({changePct >= 0 ? "+" : "−"}
            {Math.abs(changePct).toFixed(2)}%)
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex w-full flex-wrap gap-1" role="radiogroup" aria-label="Zaman aralığı">
        {RANGES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={range === option.id}
            data-testid={`chart-range-${option.id}`}
            onClick={() => setRange(option.id)}
            className={cx(
              "min-h-9 rounded-[var(--radius-sm)] border px-3 text-xs font-medium transition-colors",
              range === option.id
                ? "border-accent-line bg-accent-soft text-accent"
                : "border-line-strong bg-surface text-muted hover:bg-surface-3",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {busy ? (
          <p className="py-8 text-center text-xs text-subtle" role="status">
            Grafik yükleniyor…
          </p>
        ) : error !== null ? (
          <p className="py-8 text-center text-xs text-negative" role="status">
            {error}
          </p>
        ) : points.length === 0 ? (
          <p className="py-8 text-center text-xs text-subtle" role="status" data-testid="chart-empty">
            Bu aralıkta henüz kayıtlı fiyat gözlemi yok. Grafik, fiyat toplandıkça dolar.
          </p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
              className="h-40 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Portföy değeri grafiği, ${points.length} gözlem`}
              data-testid="chart-svg"
            >
              <path d={area} fill="var(--color-accent-soft)" stroke="none" />
              <path
                d={line}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* Nokta sayısı azken gözlemler tek tek görünür: veri seyrekliği gizlenmez. */}
              {coords.length <= 60
                ? coords.map((coord) => (
                    <circle
                      key={coord.point.at}
                      cx={coord.x}
                      cy={coord.y}
                      r={2}
                      fill="var(--color-accent)"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))
                : null}
            </svg>

            <div className="mt-1 flex justify-between text-[11px] text-subtle">
              <span className="tabular">{formatTick(points[0]!.at, range)}</span>
              <span className="tabular">{formatTick(points[points.length - 1]!.at, range)}</span>
            </div>

            <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-subtle">
              <span className="tabular">En düşük {formatMoney(min.toFixed(2))}</span>
              <span className="tabular">En yüksek {formatMoney(max.toFixed(2))}</span>
            </div>
          </>
        )}
      </div>

      {points.length > 0 ? (
        <p className="mt-2 break-words text-[11px] leading-relaxed text-subtle" data-testid="chart-note">
          {String(points.length)} gerçek gözlem çizildi. {describeStep(data?.medianStepMs ?? null)} Noktaların arası
          doldurulmaz; grafik yalnızca fiyat geldiğinde kırılır.
          {partial ? " Bazı noktalarda elde olan ürünlerin bir kısmının fiyatı yoktu; o ürünler toplama katılmadı." : ""}
        </p>
      ) : null}
    </Card>
  );
}
