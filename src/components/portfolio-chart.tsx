"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatMoney, formatPercent } from "@/lib/format";
import { usePortfolio } from "@/state/portfolio-store";
import { Card, cx } from "./ui";

/**
 * PORTFÖY DEĞERİ GRAFİĞİ
 *
 * ARALIK = MUM ADIMI, "SON ŞU KADAR SÜRE" DEĞİL.
 * Borsa arayüzlerindeki 1H / 1D / 1W ile aynı anlam: 1sa seçilince grafik en
 * baştan itibaren saatlik kovalara bölünür, her kovanın kapanışı bir nokta olur
 * ve noktalar birleştirilerek çizgi çizilir. Geriye ne kadar gidildiği
 * aralıktan TÜRETİLİR (aralık × en fazla nokta), tıpkı borsada ekranda sabit
 * sayıda mum tutulması gibi.
 *
 * ÇÖZÜNÜRLÜK UYDURULMAZ. Fiyat ~5-10 dakikada bir toplanıyor; bu yüzden 1m
 * veya 1s aralığı YOKTUR ve bir kovaya hiç gözlem düşmediyse o kova boş kalır,
 * bir öncekinin değeriyle DOLDURULMAZ. Nokta yatay yerini ZAMANDAN alır ve
 * boşluk bir adımdan uzunsa çizgi orada KIRILIR; kaç kovanın boş kaldığı
 * grafiğin altında yazar.
 *
 * Kütüphane kullanılmaz: çizgi satır içi SVG'dir. Tek bir çizgi ve birkaç
 * eksen etiketi için paket eklemek gereksiz bağımlılıktır.
 */

const INTERVALS = [
  { id: "1h", label: "1sa", ms: 60 * 60_000 },
  { id: "1d", label: "1gün", ms: 24 * 60 * 60_000 },
  // "1h" YAZILMAZ: Türkçede hem "1 saat" hem "1 hafta" okunur.
  { id: "1w", label: "1hafta", ms: 7 * 24 * 60 * 60_000 },
] as const;

type IntervalId = (typeof INTERVALS)[number]["id"];

interface HistoryPoint {
  at: string;
  liquidationValue: string;
  pricedProducts: number;
  missingProducts: number;
}

interface HistoryResponse {
  points: HistoryPoint[];
  emptyIntervals: number;
  ledgerChangesInRange: number;
}

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 180;
const PADDING_X = 8;
const PADDING_Y = 12;

/** Eksen etiketi: kısa aralıklarda saat, uzun aralıklarda tarih. */
function formatTick(iso: string, interval: IntervalId): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const showTime = interval === "1h";
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
    year: "numeric",
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

  /*
   * YATAY EKSEN ZAMANDIR, SIRA NUMARASI DEĞİL.
   *
   * Noktalar dizideki sıralarına göre eşit aralıklarla dizilseydi, hiç ölçüm
   * yapılamayan saatler ile ölçülen dakikalar ekranda aynı genişlikte
   * görünürdü: boşluk, doldurulmuş bir grafikten ayırt edilemezdi.
   */
  const stepMs = INTERVALS.find((option) => option.id === intervalId)?.ms ?? 0;
  const firstAt = points.length > 0 ? Date.parse(points[0]!.at) : 0;
  const lastAt = points.length > 0 ? Date.parse(points[points.length - 1]!.at) : 0;

  const coords = points.map((point) => {
    const at = Date.parse(point.at);
    const x =
      lastAt === firstAt
        ? VIEW_WIDTH / 2
        : PADDING_X + ((at - firstAt) / (lastAt - firstAt)) * (VIEW_WIDTH - PADDING_X * 2);
    const value = Number(point.liquidationValue);
    /*
     * Bütün değerler eşitse çizgi kutunun DİBİNE değil ORTASINA gelir:
     * hareketsiz bir portföy "dibe vurmuş" gibi okunmamalı.
     */
    const y =
      max === min
        ? VIEW_HEIGHT / 2
        : VIEW_HEIGHT - PADDING_Y - ((value - min) / span) * (VIEW_HEIGHT - PADDING_Y * 2);
    return { x, y, at, point };
  });

  /*
   * ÖLÇÜLMEMİŞ ARALIKTA ÇİZGİ KIRILIR.
   *
   * İki nokta arasındaki süre bir adımın 1,5 katını aşıyorsa arada hiç gözlem
   * yok demektir; "L" yerine "M" yazılır ve boşluk düz bir tırmanışla
   * kapatılmaz. Aksi hâlde grafik, boş kovayı doldurmakla aynı şeyi çizerdi.
   */
  const line = coords
    .map((coord, index) => {
      const previous = coords[index - 1];
      const gap = previous !== undefined && coord.at - previous.at > stepMs * 1.5;
      return `${index === 0 || gap ? "M" : "L"}${coord.x.toFixed(1)} ${coord.y.toFixed(1)}`;
    })
    .join(" ");

  const first = values[0];
  const last = values[values.length - 1];
  /* Tek nokta karşılaştırma DEĞİLDİR: ikinci bir ölçüm yokken "değişmedi" denmez. */
  const change = points.length >= 2 && first !== undefined && last !== undefined ? last - first : null;
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

  /*
   * KAPSAM DA EŞİT OLMALI.
   *
   * Bir ürünün o anda fiyatı yoksa toplama girmez. İki uç nokta aynı ürünleri
   * kapsamıyorsa aradaki fark fiyat hareketi değil, ölçümün EKSİKLİĞİDİR:
   * sonradan fiyatlanan bir ürün, hiç fiyat oynamamışken devasa bir "artış"
   * gibi görünür. Böyle bir farkın kâr/zarar rengini alması yasaktır.
   */
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const sameCoverage =
    firstPoint !== undefined &&
    lastPoint !== undefined &&
    firstPoint.missingProducts === 0 &&
    lastPoint.missingProducts === 0 &&
    firstPoint.pricedProducts === lastPoint.pricedProducts;
  const changeIsPriceOnly = flows === 0 && sameCoverage;
  const emptyIntervals = data?.emptyIntervals ?? 0;

  return (
    <Card className="p-4" data-testid="portfolio-chart">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">Değer değişimi</p>
          <p className="mt-0.5 text-xs text-muted">Bugün bozdurursanız alacağınız tutar</p>
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
              {formatMoney(Math.abs(change).toFixed(2))} ({formatPercent(changePct)})
            </span>
            {flows > 0 ? (
              <span className="mt-0.5 block text-[11px] font-normal text-subtle" data-testid="chart-change-basis">
                Alım/satım dâhil, kâr değil
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex w-full flex-wrap gap-1" role="radiogroup" aria-label="Grafik aralığı">
        {INTERVALS.map((option) => (
          /* Sesli ad, düğmenin ÜSTÜNDE yazanı içermek zorundadır (WCAG 2.5.3). */
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={intervalId === option.id}
            aria-label={`${option.label} aralığı`}
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
            Henüz yeterli fiyat kaydı yok; grafik zamanla oluşur.
          </p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
              className="h-40 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label="Portföy değeri grafiği"
              data-testid="chart-svg"
            >
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

      {/*
        Not YALNIZCA söylenecek bir şey varken çıkar: çizgide gerçek boşluk
        varsa (boş kova sayısı kullanıcıya yazılmak zorunda) veya bazı ürünler
        fiyatsız olduğu için toplama girmediyse. Normal bir günde hiç metin yok.
      */}
      {points.length > 0 && (emptyIntervals > 0 || partial) ? (
        <p className="mt-2 break-words text-[11px] leading-relaxed text-subtle" data-testid="chart-note">
          {emptyIntervals > 0 ? `${String(emptyIntervals)} kez fiyat kaydı alınamadı; çizgide boşluk var. ` : ""}
          {partial ? "Fiyatı olmayan ürünler grafiğe katılmadı." : ""}
        </p>
      ) : null}
    </Card>
  );
}
