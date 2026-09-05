"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import { usePortfolio } from "@/state/portfolio-store";
import { Card, cx } from "./ui";

/**
 * PORTFÖY DEĞERİ GRAFİĞİ
 *
 * ARALIK = MUM ADIMI, "SON ŞU KADAR SÜRE" DEĞİL.
 * Borsa arayüzlerindeki 15m / 1H / 4H / 1D / 1W ile aynı anlam: 1H seçilince
 * grafik en baştan itibaren saatlik kovalara bölünür, her kovanın kapanışı bir
 * nokta olur ve noktalar birleştirilerek çizgi çizilir. Geriye ne kadar
 * gidildiği aralıktan TÜRETİLİR (aralık × en fazla nokta), tıpkı borsada ekranda
 * sabit sayıda mum tutulması gibi.
 *
 * ÇÖZÜNÜRLÜK UYDURULMAZ. Fiyat ~5-10 dakikada bir toplanıyor; bu yüzden 1m
 * veya 1s aralığı YOKTUR ve bir kovaya hiç gözlem düşmediyse o kova boş kalır,
 * bir öncekinin değeriyle DOLDURULMAZ. Kaç kovanın boş kaldığı grafiğin
 * altında yazar.
 *
 * Kütüphane kullanılmaz: çizgi satır içi SVG'dir. Tek bir çizgi ve birkaç
 * eksen etiketi için paket eklemek gereksiz bağımlılıktır.
 */

const INTERVALS = [
  { id: "15m", label: "15dk" },
  { id: "1h", label: "1sa" },
  { id: "4h", label: "4sa" },
  { id: "1d", label: "1gün" },
  // "1h" YAZILMAZ: Türkçede hem "1 saat" hem "1 hafta" okunur.
  { id: "1w", label: "1hafta" },
] as const;

type IntervalId = (typeof INTERVALS)[number]["id"];

/** Kullanıcıya yazılan tam ad (kısa düğme etiketi yeterince açık değil). */
const INTERVAL_NAMES: Readonly<Record<IntervalId, string>> = {
  "15m": "15 dakikalık",
  "1h": "saatlik",
  "4h": "4 saatlik",
  "1d": "günlük",
  "1w": "haftalık",
};

interface HistoryPoint {
  at: string;
  observedAt: string;
  liquidationValue: string;
  pricedProducts: number;
  missingProducts: number;
  observations: number;
}

interface HistoryResponse {
  interval: string;
  points: HistoryPoint[];
  medianStepMs: number | null;
  emptyIntervals: number;
  empty: boolean;
  ledgerChangesInRange: number;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 180;
const PADDING_X = 8;
const PADDING_Y = 12;

function describeStep(ms: number | null): string {
  if (ms === null) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Fiyat saniyeler arayla toplanıyor.";
  if (minutes === 1) return "Fiyat yaklaşık dakikada bir toplanıyor.";
  if (minutes < 60) return `Fiyat yaklaşık ${String(minutes)} dakikada bir toplanıyor.`;
  const hours = Math.round(minutes / 60);
  return `Fiyat yaklaşık ${String(hours)} saatte bir toplanıyor.`;
}

/** Eksen etiketi: kısa aralıklarda saat, uzun aralıklarda tarih. */
function formatTick(iso: string, interval: IntervalId): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const showTime = interval === "15m" || interval === "1h" || interval === "4h";
  if (showTime) {
    return date.toLocaleString("tr-TR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Istanbul",
    });
  }
  return date.toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "Europe/Istanbul",
  });
}

export function PortfolioChart() {
  const { summary } = usePortfolio();
  const [intervalId, setIntervalId] = useState<IntervalId>("1h");

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
    interval: IntervalId;
    data: HistoryResponse | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<HistoryResponse>(`/api/portfolio/history?interval=${intervalId}`)
      .then((response) => {
        if (!cancelled) setResult({ interval: intervalId, data: response, error: null });
      })
      .catch(() => {
        if (!cancelled) setResult({ interval: intervalId, data: null, error: "Grafik verisi alınamadı." });
      });
    return () => {
      cancelled = true;
    };
  }, [intervalId, snapshotAt]);

  /*
   * Yenileme sırasında ESKİ grafik ekranda kalır: aynı aralığın verisi
   * duruyorsa "yükleniyor" yazısına düşmek, saniyede bir grafiğin kaybolup
   * gelmesi demek olurdu. Yalnızca aralık değişince veya ilk açılışta beklenir.
   */
  const busy = result === null || result.interval !== intervalId;
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

  /*
   * ARALIK İÇİNDE ALIM/SATIM VARSA FARK "KÂR" DEĞİLDİR.
   *
   * Grafik portföyün DEĞERİNİ çizer. Kullanıcı aralık içinde altın aldıysa
   * değer, fiyat hiç değişmese bile yükselir. Bu farkı yeşil bir yüzdeyle
   * göstermek 50.000 TL'lik bir alımı "+%500 kazanç" diye okuturdu.
   *
   * Bu durumda rakam GİZLENMEZ — portföy değeri gerçekten o kadar değişti —
   * ama kâr/zarar rengi kaldırılır ve neyin dâhil olduğu yazılır. Gerçek
   * kâr/zarar zaten üstteki K/Z kartlarında, maliyete karşı hesaplanıyor.
   */
  const flows = data?.ledgerChangesInRange ?? 0;
  const changeIsPriceOnly = flows === 0;
  const emptyIntervals = data?.emptyIntervals ?? 0;

  return (
    <Card className="p-4" data-testid="portfolio-chart">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">Portföy değeri</p>
          <p className="mt-0.5 text-xs text-muted">
            Bozdurma değeri, {INTERVAL_NAMES[intervalId]} adımlarla
          </p>
        </div>
        {change !== null && changePct !== null ? (
          <p className="text-right">
            <span
              className={cx(
                "tabular text-sm font-semibold",
                !changeIsPriceOnly ? "text-ink" : change >= 0 ? "text-positive" : "text-negative",
              )}
              data-testid="chart-change"
            >
              {change >= 0 ? "+" : "−"}
              {formatMoney(Math.abs(change).toFixed(2))} ({changePct >= 0 ? "+" : "−"}
              {Math.abs(changePct).toFixed(2)}%)
            </span>
            <span className="mt-0.5 block text-[11px] font-normal text-subtle" data-testid="chart-change-basis">
              {changeIsPriceOnly ? "grafiğin başından bugüne" : "alım/satım dâhil — kâr/zarar değildir"}
            </span>
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex w-full flex-wrap gap-1" role="radiogroup" aria-label="Grafik aralığı">
        {INTERVALS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={intervalId === option.id}
            aria-label={`${INTERVAL_NAMES[option.id]} grafik`}
            data-testid={`chart-interval-${option.id}`}
            onClick={() => setIntervalId(option.id)}
            className={cx(
              "min-h-9 rounded-[var(--radius-sm)] border px-3 text-xs font-medium transition-colors",
              intervalId === option.id
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
              aria-label={`Portföy değeri grafiği, ${INTERVAL_NAMES[intervalId]} ${String(points.length)} nokta`}
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
              {/* Nokta sayısı azken kovalar tek tek görünür: veri seyrekliği gizlenmez. */}
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
              <span className="tabular">{formatTick(points[0]!.at, intervalId)}</span>
              <span className="tabular">{formatTick(points[points.length - 1]!.at, intervalId)}</span>
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
          {String(points.length)} {INTERVAL_NAMES[intervalId]} nokta. Her nokta, o aralığa düşen son
          gözlemin değeridir. {describeStep(data?.medianStepMs ?? null)}
          {emptyIntervals > 0
            ? ` ${String(emptyIntervals)} aralıkta hiç gözlem yoktu; o aralıklar boş bırakıldı, bir önceki değerle doldurulmadı.`
            : ""}
          {changeIsPriceOnly
            ? ""
            : ` Bu aralıkta ${String(flows)} işlem yaptınız; çizgideki sıçramaların bir kısmı fiyat değil, eklediğiniz veya çıkardığınız varlıktır.`}
          {partial ? " Bazı noktalarda elde olan ürünlerin bir kısmının fiyatı yoktu; o ürünler toplama katılmadı." : ""}
        </p>
      ) : null}
    </Card>
  );
}
