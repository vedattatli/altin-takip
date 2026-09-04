"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  COST_QUALITY_DESCRIPTIONS,
  COST_QUALITY_LABELS,
  dec,
  PARTIAL_VALUATION_LABEL,
  PNL_LABELS,
  PRICE_UNAVAILABLE_LABEL,
  type HoldingView,
} from "@/domain/accounting";
import {
  formatDateTime,
  formatGrams,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
} from "@/lib/format";
import {
  displayProductName,
  isPrimaryProduct,
  plannedProviderFor,
  SHARED_CATEGORY_NOTE,
  sourceBadgeFor,
  summarizeSources,
  VALUATION_PLAN_DESCRIPTION,
  VALUATION_PLAN_NAME,
} from "@/prices/valuation-plan";
import { usePortfolio } from "@/state/portfolio-store";
import { useViewMode } from "@/state/view-mode";
import { PriceSourceLine } from "./price-source-line";
import { Card, DeltaValue, EmptyState, SectionTitle, cx } from "./ui";

const PRICE_UNAVAILABLE = PRICE_UNAVAILABLE_LABEL;

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

function CostQualityBadge({ holding }: { holding: HoldingView }) {
  const quality = holding.costQuality;
  if (quality === "NONE") return null;
  return (
    <span
      className={cx("badge", quality === "ACTUAL" ? "badge-positive" : "badge-notice")}
      title={COST_QUALITY_DESCRIPTIONS[quality]}
      data-testid="cost-quality"
    >
      {COST_QUALITY_LABELS[quality]}
    </span>
  );
}

/**
 * KAYNAK ROZETİ
 *
 * Kullanıcıya teknik sağlayıcı kimliği veya güven seviyesi gösterilmez;
 * yalnızca piyasanın adı görünür. Fiyat henüz gelmediyse PLANLANAN kaynak
 * yazılır — böylece "bu ürün hangi kaynaktan değerlenecek" sorusu fiyat
 * gelmeden de yanıtlıdır.
 */
function SourceBadge({ productId, quoteProvider }: { productId: string; quoteProvider: string | null }) {
  const badge = sourceBadgeFor(quoteProvider ?? plannedProviderFor(productId));
  if (!badge) return null;
  return (
    <span className="badge" title={badge.description} data-testid="source-badge">
      {badge.label}
    </span>
  );
}

function HoldingRow({
  holding,
  distinguish,
  sharedFrom,
  simple,
}: {
  holding: HoldingView;
  /** Aynı görünüm grubundan birden çok kayıt varsa satırlar ayırt edilir. */
  distinguish: boolean;
  /** Fiyat ortak kategori fiyatından alındıysa kaynak ürünün kimliği. */
  sharedFrom: string | null;
  /** Basit modda muhasebe ayrıntıları gizlenir; hesaplar değişmez. */
  simple: boolean;
}) {
  const { product, position, quote } = holding;
  const priced = holding.priceAvailable && holding.liquidationValue !== null;
  const name = displayProductName(product.id, product.name, { distinguish });

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0" data-testid="holding-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-ink">{name}</p>
            <CostQualityBadge holding={holding} />
            <SourceBadge productId={product.id} quoteProvider={quote?.provider ?? null} />
          </div>
          <p className="tabular mt-0.5 text-xs text-muted">
            {formatQuantity(position.quantity, product.unit)} · {formatGrams(holding.pureGoldGrams)} has
          </p>
          <p className="tabular mt-0.5 text-xs text-muted">
            Ortalama maliyet: {position.averageCost ? formatMoney(position.averageCost) : "—"}/{product.unit}
            {simple ? "" : ` · Kalan maliyet: ${formatMoney(position.remainingCostBasis)}`}
          </p>
          {quote ? (
            <p className="tabular mt-0.5 text-xs text-subtle">
              Bozdurma: {formatMoney(quote.liquidationPrice)}/{product.unit} · Yeniden alım:{" "}
              {formatMoney(quote.replacementPrice)}/{product.unit} · Son güncelleme:{" "}
              {formatDateTime(quote.fetchedAt)}
            </p>
          ) : null}
          {sharedFrom !== null ? (
            <p className="mt-0.5 text-xs text-subtle" title={SHARED_CATEGORY_NOTE} data-testid="shared-category">
              Ortak kategori fiyatı
            </p>
          ) : null}
          {holding.costQuality === "MIXED" ? (
            <p className="mt-0.5 text-xs text-subtle">{COST_QUALITY_DESCRIPTIONS.MIXED}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-sm font-semibold text-ink">
            {priced ? formatMoney(holding.liquidationValue!) : PRICE_UNAVAILABLE}
          </p>
          {priced ? (
            <p className="tabular mt-0.5 text-xs text-muted">Yeniden alım {formatMoney(holding.replacementValue!)}</p>
          ) : null}
        </div>
      </div>
      {priced && holding.unrealizedPnl !== null ? (
        <p className="mt-1.5 text-xs">
          <DeltaValue
            value={holding.unrealizedPnl}
            formatted={formatSignedMoney(holding.unrealizedPnl)}
            suffix={holding.unrealizedPnlPercent !== null ? formatPercent(holding.unrealizedPnlPercent) : undefined}
          />
          <span className="ml-1 text-subtle">{simple ? "kâr/zarar" : "gerçekleşmemiş"}</span>
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-muted">
          Bu ürün için güncel fiyat alınamıyor; değerleme ve gerçekleşmemiş K/Z hesaplanmadı. Başka
          bir kaynağın fiyatı bu ürüne yazılmaz.
        </p>
      )}
      {!simple && !dec(position.realizedPnl).isZero() ? (
        <p className="tabular mt-0.5 text-xs text-muted">
          Gerçekleşmiş: <DeltaValue value={position.realizedPnl} formatted={formatSignedMoney(position.realizedPnl)} />
        </p>
      ) : null}
    </li>
  );
}

export function DashboardView({ addHref, onAdd }: { addHref?: string; onAdd?: () => void }) {
  const {
    summary,
    snapshot,
    status,
    error,
    isOnline,
    repository,
    refreshPrices,
    portfolio,
    lastSyncedAt,
    syncStatus,
  } = usePortfolio();
  const { isSimple } = useViewMode();

  const base = addHref ?? "/islemler";
  /*
   * Basit modda SATIŞ düğmesi gösterilmez: günlük kullanımda altın eklenir,
   * satılmaz. Satış özelliği KALDIRILMADI — detaylı moda geçince yerindedir
   * ve kayıtlar aynen durur.
   */
  const actionButtons = onAdd ? (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-secondary min-h-11" onClick={onAdd}>
        Mevcut Altını Ekle
      </button>
      <button type="button" className="btn btn-primary min-h-11" onClick={onAdd}>
        {isSimple ? "Altın Ekle" : "Yeni Alış Ekle"}
      </button>
      {isSimple ? null : (
        <button type="button" className="btn btn-secondary min-h-11" onClick={onAdd}>
          Satış Ekle
        </button>
      )}
    </div>
  ) : (
    <div className="flex flex-wrap gap-2">
      <Link href={`${base}?ekle=mevcut`} className="btn btn-secondary min-h-11">
        Mevcut Altını Ekle
      </Link>
      <Link href={`${base}?ekle=alis`} className="btn btn-primary min-h-11">
        {isSimple ? "Altın Ekle" : "Yeni Alış Ekle"}
      </Link>
      {isSimple ? null : (
        <Link href={`${base}?ekle=satis`} className="btn btn-secondary min-h-11">
          Satış Ekle
        </Link>
      )}
    </div>
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

  /*
   * Üç ayrı durum:
   *   NEVER_USED : hiç işlem yok → 0 TL ve "Henüz altın eklenmedi"
   *   CLOSED     : geçmiş işlem var, açık pozisyon yok → gerçekleşmiş K/Z korunur, "Açık pozisyonunuz bulunmuyor"
   *   OPEN       : açık pozisyon var → değerleme KAPSAMA göre (full / partial / none)
   * Değerleme kararı sağlayıcı meta durumuna değil, eldeki pozisyonlar için gerçekten
   * kullanılabilir quote kapsamına (valuationStatus) göre verilir.
   */
  const portfolioState = summary.portfolioState;
  const isNeverUsed = portfolioState === "NEVER_USED";
  const isClosed = portfolioState === "CLOSED";
  const isOpen = portfolioState === "OPEN";
  const isEmpty = !isOpen;
  const noPrices = isOpen && summary.valuationStatus === "none";
  const partial = isOpen && summary.valuationStatus === "partial";
  const priceOk = !noPrices;
  const partialSuffix = partial ? " (kısmi)" : "";
  const coverageText = partial
    ? `${PARTIAL_VALUATION_LABEL}: yalnızca fiyatı bulunan ${summary.pricedPositionCount}/${summary.positionCount} varlığın toplamı`
    : null;
  // Açık pozisyon yoksa değer 0 TL'dir; açık pozisyon var ama hiç kullanılabilir fiyat yoksa "kullanılamıyor" (0 TL DEĞİL).
  const valuation = (value: string) => (noPrices ? PRICE_UNAVAILABLE : formatMoney(value));
  const pnlText = PNL_LABELS[summary.pnlLabel];

  /*
   * GÖRÜNÜM AYIRIMI
   *
   * Katalogdaki 21 ürünün hepsi korunur; varsayılan ekranda yalnız altı
   * ürünün grubu görünür. Gizlenen bir üründe kayıt varsa kayıt KAYBOLMAZ,
   * "Diğer varlıklar" başlığı altında listelenir.
   */
  const openHoldings = summary.holdings.filter((holding) => dec(holding.position.quantity).greaterThan(0));
  const primaryHoldings = openHoldings.filter((holding) => isPrimaryProduct(holding.product.id));
  const otherHoldings = openHoldings.filter((holding) => !isPrimaryProduct(holding.product.id));

  /*
   * Aynı görünüm grubundan (örn. Yeni Çeyrek + Eski Çeyrek) birden çok kayıt
   * varsa satırlar aynı adı taşırdı. Bu durumda katalog adı parantez içinde
   * eklenerek kayıtların birbirine karışması engellenir.
   */
  const groupCounts = new Map<string, boolean>();
  for (const holding of openHoldings) {
    const label = displayProductName(holding.product.id, holding.product.name);
    const clash = openHoldings.some(
      (other) =>
        other.product.id !== holding.product.id &&
        displayProductName(other.product.id, other.product.name) === label,
    );
    groupCounts.set(holding.product.id, clash);
  }

  /** Fiyat ortak kategori fiyatından mı geldi? Plan bunu anlık görüntüde beyan eder. */
  const sharedFrom = (productId: string): string | null =>
    summary.snapshot?.provider.memberProviders?.[productId]?.sharedFrom ?? null;

  const sourceSummary = summarizeSources(
    openHoldings
      .map((holding) => holding.quote?.provider)
      .filter((code): code is string => typeof code === "string"),
  );

  return (
    <div className="space-y-5" data-portfolio-state={portfolioState} data-valuation-status={summary.valuationStatus}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {portfolio?.name ?? "Portföyüm"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Bozdurma değeri kuyumcunun alış fiyatına, yeniden alım değeri kuyumcunun satış fiyatına
          göre hesaplanır. Maliyet yöntemi: ürün bazlı hareketli ağırlıklı ortalama.
        </p>
      </div>

      {isClosed ? (
        <div
          className="rounded-[var(--radius)] border border-line bg-surface-2 px-3.5 py-3 text-sm text-muted"
          data-testid="portfolio-closed"
        >
          <span className="font-semibold text-ink">Açık pozisyonunuz bulunmuyor.</span> Geçmiş işlemleriniz ve
          gerçekleşmiş K/Z kayıtlarınız korunuyor.
        </div>
      ) : null}

      {/*
        BASİT MOD: üç kart yeter — portföy değeri, maliyet, kâr/zarar.
        "Kâr/Zarar" olarak TOPLAM kâr/zarar gösterilir (gerçekleşmiş +
        gerçekleşmemiş). Kullanıcı hiç satış yapmadıysa bu zaten
        gerçekleşmemiş kâr/zarara eşittir; satış yaptıysa sayıyı eksik
        göstermek yerine tamamını gösterir.
      */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={isSimple ? `Portföy değeri${partialSuffix}` : `Tahmini bozdurma değeri${partialSuffix}`}
          value={valuation(summary.totalLiquidationValue)}
          hint={coverageText ?? "Bugün bozdurursanız yaklaşık elinize geçecek tutar"}
          emphasis
          testId="stat-liquidation"
        />
        {isSimple ? null : (
          <StatCard
            label={`Yeniden alım değeri${partialSuffix}`}
            value={valuation(summary.totalReplacementValue)}
            hint={coverageText ?? "Aynı miktarı bugün almanın yaklaşık maliyeti"}
            testId="stat-repurchase"
          />
        )}
        <StatCard
          label={isSimple ? "Toplam maliyet" : "Elde kalan maliyet"}
          value={formatMoney(summary.totalRemainingCostBasis)}
          hint="Elde kalan altınların maliyet bazı (masraflar dâhil)"
          testId="stat-cost"
        />
        {isSimple ? (
          <Card className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Kâr/Zarar{partialSuffix}</p>
            <p data-testid="stat-simple-pnl" className="mt-1.5 text-xl font-semibold sm:text-2xl">
              {isEmpty || priceOk ? (
                <DeltaValue value={summary.totalPnl} formatted={formatSignedMoney(summary.totalPnl)} />
              ) : (
                <span className="text-muted">{PRICE_UNAVAILABLE}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              {summary.totalUnrealizedPnlPercent !== null && priceOk
                ? `Maliyete göre ${formatPercent(summary.totalUnrealizedPnlPercent)}`
                : "Güncel fiyatla maliyetiniz arasındaki fark"}
              {partial ? ` · ${PARTIAL_VALUATION_LABEL}` : ""}
            </p>
          </Card>
        ) : (
          <>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                Gerçekleşmemiş K/Z{partialSuffix}
              </p>
              <p data-testid="stat-unrealized" className="mt-1.5 text-xl font-semibold sm:text-2xl">
                {isEmpty || priceOk ? (
                  <DeltaValue
                    value={summary.totalUnrealizedPnl}
                    formatted={formatSignedMoney(summary.totalUnrealizedPnl)}
                  />
                ) : (
                  <span className="text-muted">{PRICE_UNAVAILABLE}</span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted">
                {summary.totalUnrealizedPnlPercent !== null && priceOk
                  ? `${pnlText} · ${formatPercent(summary.totalUnrealizedPnlPercent)}`
                  : pnlText}
                {partial ? ` · ${PARTIAL_VALUATION_LABEL}` : ""}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Gerçekleşmiş K/Z</p>
              <p data-testid="stat-realized" className="mt-1.5 text-xl font-semibold sm:text-2xl">
                <DeltaValue value={summary.totalRealizedPnl} formatted={formatSignedMoney(summary.totalRealizedPnl)} />
              </p>
              <p className="mt-1 text-xs text-muted">
                Satışlardan oluşan sonuç; portföy değerine eklenmez
                {partial ? "; fiyat eksikliğinden etkilenmez" : ""}.
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Toplam K/Z{partialSuffix}</p>
              <p data-testid="stat-total-pnl" className="mt-1.5 text-xl font-semibold sm:text-2xl">
                {isEmpty || priceOk ? (
                  <DeltaValue value={summary.totalPnl} formatted={formatSignedMoney(summary.totalPnl)} />
                ) : (
                  <span className="text-muted">{PRICE_UNAVAILABLE}</span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted">
                {noPrices
                  ? `Gerçekleşmemiş K/Z hesaplanamadı; gerçekleşmiş K/Z ${formatSignedMoney(summary.totalRealizedPnl)}`
                  : isClosed
                    ? "Açık pozisyon yok; toplam K/Z gerçekleşmiş K/Z'ye eşittir"
                    : `Gerçekleşmiş + gerçekleşmemiş · ${pnlText}`}
                {partial ? " · kesin toplam değildir (fiyatı olmayan varlıklar hariç)" : ""}
              </p>
            </Card>
          </>
        )}
      </div>

      {summary.hasEstimatedOrBaseline ? (
        <div
          className="rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3.5 py-3 text-sm text-[var(--notice)]"
          data-testid="pnl-label-notice"
        >
          <span className="font-semibold">{PNL_LABELS.SINCE_TRACKING_START}:</span>{" "}
          {summary.holdingHasEstimatedOrBaseline
            ? "portföyde takip başlangıç değeri veya tahmini maliyetle eklenmiş altın var. Bu değerler gerçek tarihsel alış maliyeti değildir; kâr/zarar takip başlangıcından itibaren hesaplanır."
            : "elde kalan altınların tamamı gerçek maliyetli; ancak geçmiş satışların bir kısmı takip başlangıç değerine veya tahmini maliyete dayandığından toplam kâr/zarar gerçek tarihsel maliyet iddiası taşımaz."}
        </div>
      ) : null}

      {noPrices ? (
        <div
          className="rounded-[var(--radius)] border border-negative-soft bg-negative-soft px-3.5 py-3 text-sm text-negative"
          data-testid="valuation-none"
        >
          {PRICE_UNAVAILABLE}: elinizdeki ürünler için fiyat yok, geçersiz veya bayat. Güncel değer ve
          gerçekleşmemiş K/Z hesaplanmış gibi gösterilmez; başka ürünün fiyatından tahmin yapılmaz.
          Elde kalan maliyet ve gerçekleşmiş K/Z fiyattan bağımsızdır.
        </div>
      ) : summary.hasMissingPrices ? (
        <div
          className="rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3.5 py-3 text-sm text-[var(--notice)]"
          data-testid="partial-valuation"
        >
          <span className="font-semibold">{PARTIAL_VALUATION_LABEL}:</span> {summary.unpricedPositionCount} ürün için
          fiyat alınamadı. Bozdurma, yeniden alım ve gerçekleşmemiş K/Z toplamları yalnızca fiyatı bulunan{" "}
          {summary.pricedPositionCount} varlığı kapsar; fiyatı olmayan varlıkların maliyet toplamı{" "}
          {formatMoney(summary.unpricedCostBasis)}. Gerçekleşmiş K/Z bundan etkilenmez.
        </div>
      ) : null}

      <section>
        <SectionTitle
          title="Varlıklarım"
          description={
            isOpen
              ? `${summary.positionCount} üründe toplam ${formatGrams(summary.totalPureGoldGrams)} has altın`
              : isClosed
                ? "Açık pozisyon yok"
                : undefined
          }
          action={isNeverUsed ? undefined : actionButtons}
        />
        {sourceSummary !== "" ? (
          <p className="mb-2 text-xs text-muted" data-testid="source-summary">
            {sourceSummary}
          </p>
        ) : null}
        <Card>
          {isNeverUsed ? (
            <EmptyState
              title="Henüz altın eklenmedi"
              description="Portföyünüz boş. Mevcut altınınızı ekleyin veya ilk alışınızı kaydedin; elde kalan maliyet, bozdurma değeri ve kâr/zarar otomatik hesaplansın."
              action={actionButtons}
            />
          ) : isClosed ? (
            <EmptyState
              title="Açık pozisyonunuz bulunmuyor"
              description="Geçmiş işlemleriniz ve gerçekleşmiş K/Z kayıtlarınız korunuyor. Yeni bir alış veya mevcut altın ekleyerek takibe devam edebilirsiniz."
            />
          ) : (
            <ul data-testid="holdings-list">
              {primaryHoldings.map((holding) => (
                <HoldingRow
                  key={holding.product.id}
                  holding={holding}
                  distinguish={groupCounts.get(holding.product.id) === true}
                  sharedFrom={sharedFrom(holding.product.id)}
                  simple={isSimple}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/*
        DİĞER VARLIKLAR
        Varsayılan listede görünmeyen ürünlerden elde kayıt varsa burada
        görünür. Kayıt SİLİNMEZ ve gizlenmez; yalnız ana listeyi
        kalabalıklaştırmaz. Bu ürünler satılabilir de.
      */}
      {otherHoldings.length > 0 ? (
        <section data-testid="other-holdings-section">
          <SectionTitle
            title="Diğer varlıklar"
            description={`Varsayılan listede yer almayan ${String(otherHoldings.length)} üründe kaydınız var. Bu kayıtlar korunur ve satılabilir.`}
          />
          <Card>
            <ul data-testid="other-holdings-list">
              {otherHoldings.map((holding) => (
                <HoldingRow
                  key={holding.product.id}
                  holding={holding}
                  distinguish={groupCounts.get(holding.product.id) === true}
                  sharedFrom={sharedFrom(holding.product.id)}
                  simple={isSimple}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {/*
        DEĞERLEME PLANI
        Kullanıcıya teknik sağlayıcı seçimi sunulmaz: tek bir plan vardır ve
        hangi ürünün hangi kaynaktan geldiği satır rozetlerinde zaten yazar.
      */}
      {summary.priceSource && !isSimple ? (
        <div
          className="rounded-[var(--radius)] border border-line bg-surface-2 px-3.5 py-3 text-xs"
          data-testid="active-price-source"
        >
          <p className="text-sm font-semibold text-ink">{VALUATION_PLAN_NAME}</p>
          <p className="mt-0.5 break-words text-muted">{VALUATION_PLAN_DESCRIPTION}</p>
          <p className="tabular mt-0.5 text-subtle">
            {summary.priceSource.lastQuoteAt
              ? `Son fiyat güncellemesi: ${formatDateTime(summary.priceSource.lastQuoteAt)}`
              : "Son fiyat güncellemesi: —"}
            {" · Durum: "}
            {summary.priceSource.status === "ok"
              ? "Güncel"
              : summary.priceSource.status === "stale"
                ? "Bayat (yeni fiyat alınamadı)"
                : summary.priceSource.status === "unavailable"
                  ? PRICE_UNAVAILABLE
                  : "Kaynak seçilmedi"}
            {" · "}
            {isOpen
              ? partial
                ? `${PARTIAL_VALUATION_LABEL} (${summary.pricedPositionCount}/${summary.positionCount})`
                : noPrices
                  ? "Değerleme yapılamadı"
                  : "Tam değerleme"
              : "Açık pozisyon yok"}
          </p>
          <Link className="mt-1 inline-block text-accent underline" href="/fiyat-kaynagi">
            Fiyat kaynaklarını görüntüle
          </Link>
        </div>
      ) : null}

      <PriceSourceLine
        snapshot={snapshot}
        dataStatusLabel={repository.label}
        isOnline={isOnline}
        onRefresh={() => void refreshPrices()}
        lastSyncedAt={lastSyncedAt}
        syncStatus={syncStatus}
      />
      <p className="text-xs leading-relaxed text-subtle">
        Bu uygulama vergi, muhasebe veya yatırım danışmanlığı hizmeti değildir; girdiğiniz verilere ve
        bilgilendirme amaçlı fiyatlara dayalı bir portföy takip aracıdır.
      </p>
    </div>
  );
}
