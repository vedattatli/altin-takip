"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { Holding } from "@/domain/portfolio";
import {
  formatGrams,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
} from "@/lib/format";
import { usePortfolio } from "@/state/portfolio-store";
import { PriceSourceLine } from "./price-source-line";
import { Card, DeltaValue, EmptyState, SectionTitle, cx } from "./ui";

function StatCard({
  label,
  value,
  hint,
  emphasis,
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  emphasis?: boolean;
  testId: string;
}) {
  return (
    <Card className={cx("p-4", emphasis && "border-accent-line bg-accent-soft")}>
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p
        data-testid={testId}
        className={cx(
          "tabular mt-1.5 font-semibold tracking-tight text-ink",
          emphasis ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}

function HoldingRow({ holding }: { holding: Holding }) {
  const { product, quantity, costBasis, liquidationValue, unrealizedPnL, unrealizedPnLPercent } =
    holding;

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{product.name}</p>
          <p className="mt-0.5 text-xs text-muted">
            {formatQuantity(quantity, product.unit)} · {formatGrams(holding.pureGoldGrams)} has
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-sm font-semibold text-ink">
            {liquidationValue === null ? "Fiyat yok" : formatMoney(liquidationValue)}
          </p>
          <p className="tabular mt-0.5 text-xs text-muted">Maliyet {formatMoney(costBasis)}</p>
        </div>
      </div>
      {unrealizedPnL !== null ? (
        <p className="mt-1.5 text-xs">
          <DeltaValue
            value={unrealizedPnL}
            formatted={formatSignedMoney(unrealizedPnL)}
            suffix={unrealizedPnLPercent !== null ? formatPercent(unrealizedPnLPercent) : undefined}
          />
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-muted">
          Bu ürün için fiyat alınamadı; değerlemeye dâhil edilmedi.
        </p>
      )}
    </li>
  );
}

export function DashboardView({ addHref, onAdd }: { addHref?: string; onAdd?: () => void }) {
  const { summary, snapshot, status, error, isOnline, repository, refreshPrices, portfolio } =
    usePortfolio();

  const addButton = onAdd ? (
    <button type="button" className="btn btn-primary" onClick={onAdd}>
      Altın Ekle
    </button>
  ) : (
    <Link href={addHref ?? "/islemler?yeni=1"} className="btn btn-primary">
      Altın Ekle
    </Link>
  );

  if (status === "loading") {
    return (
      <div className="py-16 text-center text-sm text-muted" role="status">
        Portföyünüz yükleniyor…
      </div>
    );
  }

  if (status === "error") {
    return (
      <Card className="p-5">
        <p className="text-sm font-semibold text-negative">Portföy yüklenemedi</p>
        <p className="mt-1 text-sm text-muted">{error}</p>
      </Card>
    );
  }

  const isEmpty = summary.positionCount === 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {portfolio?.name ?? "Portföyüm"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Bozdurma değeri piyasanın alış fiyatına, yeniden alım değeri satış fiyatına göre
          hesaplanır.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label="Toplam bozdurma değeri"
          value={formatMoney(summary.totalLiquidationValue)}
          hint="Bugün bozdurursanız yaklaşık eline geçecek tutar"
          emphasis
          testId="stat-liquidation"
        />
        <StatCard
          label="Toplam yeniden alım değeri"
          value={formatMoney(summary.totalRepurchaseValue)}
          hint="Aynı miktarı bugün almanın yaklaşık maliyeti"
          testId="stat-repurchase"
        />
        <StatCard
          label="Toplam maliyet"
          value={formatMoney(summary.totalCostBasis)}
          hint="İşçilik ve komisyon dâhil"
          testId="stat-cost"
        />
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Kâr / Zarar</p>
          <p data-testid="stat-pnl" className="mt-1.5 text-xl font-semibold sm:text-2xl">
            <DeltaValue
              value={summary.totalUnrealizedPnL}
              formatted={formatSignedMoney(summary.totalUnrealizedPnL)}
            />
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary.totalUnrealizedPnLPercent === null
              ? "Gerçekleşmemiş kâr/zarar"
              : `Gerçekleşmemiş · ${formatPercent(summary.totalUnrealizedPnLPercent)}`}
          </p>
        </Card>
      </div>

      {summary.hasMissingPrices ? (
        <div className="rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3.5 py-3 text-sm text-[var(--notice)]">
          Bazı ürünler için fiyat alınamadı. Bu pozisyonlar (maliyet{" "}
          {formatMoney(summary.unpricedCostBasis)}) toplam değerlemeye dâhil edilmedi.
        </div>
      ) : null}

      <section>
        <SectionTitle
          title="Varlıklarım"
          description={
            isEmpty
              ? undefined
              : `${summary.positionCount} üründe toplam ${formatGrams(summary.totalPureGoldGrams)} has altın`
          }
          action={isEmpty ? undefined : addButton}
        />
        <Card>
          {isEmpty ? (
            <EmptyState
              title="Henüz altın eklenmedi"
              description="Portföyünüz boş. İlk altın işleminizi ekleyin; toplam maliyetiniz, bozdurma değeriniz ve kâr/zararınız otomatik hesaplansın."
              action={addButton}
            />
          ) : (
            <ul data-testid="holdings-list">
              {summary.holdings
                .filter((holding) => holding.quantity > 0)
                .map((holding) => (
                  <HoldingRow key={holding.product.id} holding={holding} />
                ))}
            </ul>
          )}
        </Card>
      </section>

      {summary.totalRealizedPnL !== 0 ? (
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
            Gerçekleşmiş kâr / zarar
          </p>
          <p className="mt-1.5 text-lg">
            <DeltaValue
              value={summary.totalRealizedPnL}
              formatted={formatSignedMoney(summary.totalRealizedPnL)}
            />
          </p>
          <p className="mt-1 text-xs text-muted">Satış işlemlerinden bugüne kadar oluşan sonuç.</p>
        </Card>
      ) : null}

      {/* Fiyat kaynağı bilgisi ekranın ortasında yer kaplamaz; altta tek satırdır. */}
      <PriceSourceLine
        snapshot={snapshot}
        dataStatusLabel={repository.label}
        isOnline={isOnline}
        onRefresh={() => void refreshPrices()}
      />
    </div>
  );
}
