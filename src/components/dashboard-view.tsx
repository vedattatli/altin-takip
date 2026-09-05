"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  COST_QUALITY_LABELS,
  dec,
  type HoldingView,
  type PnlLabelKind,
} from "@/domain/accounting";
import {
  formatDateTime,
  formatGrams,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
} from "@/lib/format";
import { isPrimaryProduct } from "@/prices/valuation-plan";
import { isGoldProduct } from "@/domain/catalog";
import { usePortfolio } from "@/state/portfolio-store";
import { useViewMode } from "@/state/view-mode";
import { PortfolioChart } from "./portfolio-chart";
import { PriceSourceLine } from "./price-source-line";
import { DismissibleNotice } from "./dismissible-notice";
import { Card, DeltaValue, EmptyState, Explain, SectionTitle, cx, moneySizeClass } from "./ui";

/*
 * EKRAN METİNLERİ
 *
 * Motorun sabitleri muhasebe diliyle yazılıdır ("Fiyat verisi kullanılamıyor",
 * "Maliyet bazlı K/Z"). Panelde günlük Türkçesi gösterilir; motor sabitleri ve
 * hesaplar aynen durur. Fiyat yoksa yine SIFIR yazılmaz, bu etiket basılır.
 */
const PRICE_UNAVAILABLE = "Fiyat yok";

const PNL_BASIS_TEXT: Record<PnlLabelKind, string> = {
  COST_BASIS: "Maliyetinize göre",
  SINCE_TRACKING_START: "Takibe başladığınız günden beri",
};

function StatCard({
  label,
  value,
  valueText,
  hint,
  emphasis,
  testId,
}: {
  label: string;
  value: ReactNode;
  /** Punto seçimi için düz metin; `value` bir bileşense verilmelidir. */
  valueText?: string;
  hint?: string;
  emphasis?: boolean;
  testId: string;
}) {
  const sizing = moneySizeClass(valueText ?? (typeof value === "string" ? value : ""), emphasis === true);
  return (
    <Card className={cx("p-4", emphasis && "border-accent-line bg-accent-soft")}>
      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p
        data-testid={testId}
        className={cx("tabular stat-value mt-1.5 font-semibold tracking-tight text-ink", sizing)}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}

/**
 * MALİYET ROZETİ
 *
 * Yalnızca DİKKAT isteyen maliyet durumları rozet alır. "Gerçek maliyet"
 * normal durumdur ve neredeyse her satırda çıkardı; rozetin YOKLUĞU maliyetin
 * gerçek olduğu anlamına gelir.
 */
function CostQualityBadge({ holding }: { holding: HoldingView }) {
  const quality = holding.costQuality;
  if (quality === "NONE" || quality === "ACTUAL") return null;
  return (
    <span className="badge badge-notice" data-testid="cost-quality">
      {COST_QUALITY_LABELS[quality]}
    </span>
  );
}

function HoldingRow({
  holding,
  sharedFrom,
  simple,
}: {
  holding: HoldingView;
  /** Fiyat ortak kategori fiyatından alındıysa kaynak ürünün kimliği. */
  sharedFrom: string | null;
  /** Basit modda muhasebe ayrıntıları gizlenir; hesaplar değişmez. */
  simple: boolean;
}) {
  const { product, position, quote } = holding;
  const priced = holding.priceAvailable && holding.liquidationValue !== null;
  // Katalog adı olduğu gibi yazılır. "Yeni Çeyrek" ile "Eski Çeyrek" AYRI
  // ürünlerdir; ikisini "Çeyrek Altın" diye birleştirmek, kullanıcının hangisini
  // eklediğini ekranda gizlerdi. Seçim listesi de aynı adı gösterir.
  const name = product.name;

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0" data-testid="holding-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-ink">{name}</p>
            <CostQualityBadge holding={holding} />
          </div>
          {/*
            "has" karşılığı YALNIZCA altında yazılır. Gümüş ve dövizin has altın
            karşılığı yoktur; satırda "0 gr has" yazmak ürünü değersiz gibi
            gösteren anlamsız bir bilgiydi.
          */}
          <p className="tabular mt-0.5 text-xs text-muted">
            {formatQuantity(position.quantity, product.id)}
            {isGoldProduct(product.id) ? ` · ${formatGrams(holding.pureGoldGrams)} has` : ""}
          </p>
          <p className="tabular mt-0.5 text-xs text-muted">
            Ortalama maliyet: {position.averageCost ? formatMoney(position.averageCost) : "—"}/{product.unit}
          </p>
          {/*
            Birim fiyat kalır: kullanıcı sağdaki toplamı bununla doğruluyor.
            Fiyatın ne zaman alındığı sayfanın altındaki şeritte bir kez yazar;
            her satırda tekrarlanmaz.
          */}
          {quote ? (
            <p className="tabular mt-0.5 text-xs text-subtle">
              Bozdurma: {formatMoney(quote.liquidationPrice)}/{product.unit}
              {simple ? "" : ` · Yeniden alım: ${formatMoney(quote.replacementPrice)}/${product.unit}`}
            </p>
          ) : null}
          {/*
            Eski ve yeni ürün, kaynağın yayımladığı TEK kategori fiyatıyla
            değerlenir. Fiyat türetilmiyor; kullanıcı iki satırın neden kuruşu
            kuruşuna aynı olduğunu bilmezse ekranı yanlış okur.
          */}
          {sharedFrom !== null ? (
            <p className="mt-0.5 text-xs text-subtle" data-testid="shared-category">
              Eski ve yeni için aynı fiyat kullanılıyor.
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-sm font-semibold text-ink">
            {priced ? formatMoney(holding.liquidationValue!) : PRICE_UNAVAILABLE}
          </p>
          {/*
            Basit mod "yeniden alım" kavramını bilerek göstermez; satırda ikinci
            bir TL rakamı hangisinin portföy değeri olduğunu bulanıklaştırırdı.
          */}
          {priced && !simple ? (
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
          {/*
            Basit modda işaretli ve renkli rakam zaten kâr/zarar olarak okunur.
            Detaylı modda hemen altında bir de "Gerçekleşmiş" satırı var; ikisini
            ayıran tek şey bu kelime.
          */}
          {simple ? null : <span className="ml-1 text-subtle">gerçekleşmemiş</span>}
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-muted">Bugünkü fiyatı alınamadı; kâr/zarar hesaplanmadı.</p>
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
  const { summary, snapshot, status, error, isOnline, repository, refreshPrices, portfolio } =
    usePortfolio();
  const { isSimple } = useViewMode();

  const base = addHref ?? "/islemler";
  const addAction = (kind: "mevcut" | "alis" | "satis", label: string, className: string) =>
    onAdd ? (
      <button type="button" className={className} onClick={onAdd}>
        {label}
      </button>
    ) : (
      <Link href={`${base}?ekle=${kind}`} className={className}>
        {label}
      </Link>
    );

  const existingButton = addAction("mevcut", "Mevcut Altını Ekle", "btn btn-secondary min-h-11");
  const buyButton = addAction("alis", isSimple ? "Altın Ekle" : "Yeni Alış Ekle", "btn btn-primary min-h-11");
  const sellButton = addAction("satis", "Satış Ekle", "btn btn-secondary min-h-11");

  /*
   * Basit modda SATIŞ düğmesi gösterilmez: günlük kullanımda altın eklenir,
   * satılmaz. "Mevcut Altını Ekle" de dolu listede gizlenir; kullanıcı gözüyle
   * iki düğme de "altın ekle" demek ve aradaki muhasebe farkı düğme adından
   * anlaşılmıyor. Hiçbir akış KALDIRILMADI: mevcut altın girişi boş durum
   * kartında ve /islemler sayfasında, satış ise detaylı modda yerindedir.
   */
  const actionButtons = (
    <div className="flex flex-wrap gap-2">
      {isSimple ? null : existingButton}
      {buyButton}
      {isSimple ? null : sellButton}
    </div>
  );

  const emptyStateButtons = (
    <div className="flex flex-wrap gap-2">
      {existingButton}
      {buyButton}
      {isSimple ? null : sellButton}
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
   *   CLOSED     : geçmiş işlem var, elde varlık yok → gerçekleşmiş K/Z korunur, "Elinizde varlık kalmadı"
   *   OPEN       : açık pozisyon var → değerleme KAPSAMA göre (full / partial / none)
   * Değerleme kararı sağlayıcı meta durumuna değil, eldeki pozisyonlar için gerçekten
   * kullanılabilir quote kapsamına (valuationStatus) göre verilir.
   */
  const portfolioState = summary.portfolioState;
  const isNeverUsed = portfolioState === "NEVER_USED";
  const isClosed = portfolioState === "CLOSED";
  const isOpen = portfolioState === "OPEN";
  const noPrices = isOpen && summary.valuationStatus === "none";
  const partial = isOpen && summary.valuationStatus === "partial";
  const priceOk = !noPrices;
  // Kartın kendi "(kısmi)" eki ile tek uyarı kutusu eksik kapsamı zaten söyler;
  // aynı uyarı kart ipuçlarında tekrar edilmez.
  const partialSuffix = partial ? " (kısmi)" : "";
  // Açık pozisyon yoksa değer 0 TL'dir; açık pozisyon var ama hiç kullanılabilir fiyat yoksa "kullanılamıyor" (0 TL DEĞİL).
  const valuation = (value: string) => (noPrices ? PRICE_UNAVAILABLE : formatMoney(value));
  const pnlText = PNL_BASIS_TEXT[summary.pnlLabel];

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

  /** Fiyat ortak kategori fiyatından mı geldi? Plan bunu anlık görüntüde beyan eder. */
  const sharedFrom = (productId: string): string | null =>
    summary.snapshot?.provider.memberProviders?.[productId]?.sharedFrom ?? null;

  return (
    <div className="space-y-5" data-portfolio-state={portfolioState} data-valuation-status={summary.valuationStatus}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {portfolio?.name ?? "Portföyüm"}
        </h1>
        {/*
          Açıklama SİLİNMEDİ, katlandı. İki kartın hangi fiyat yönünü gösterdiğini
          bilmeyen kullanıcı ikisini karıştırır. Basit modda hiç yazılmaz: orada
          "yeniden alım değeri" kartı zaten gizli ve tek kartın kendi ipucu aynı
          bilgiyi veriyor.
        */}
        {isSimple ? null : (
          <Explain title="Bu sayılar nasıl hesaplanıyor?" className="mt-1.5">
            <p>
              <span className="font-medium text-ink">Bozdurma değeri</span> kuyumcunun size ödeyeceği,{" "}
              <span className="font-medium text-ink">yeniden alım değeri</span> ise aynısını bugün
              almanın bedelidir.
            </p>
          </Explain>
        )}
      </div>

      {/* Kartlar 0 TL gösteriyor; sebebi yazılmazsa kullanıcı uygulamayı bozuk sanar. */}
      {isClosed ? (
        <div
          className="rounded-[var(--radius)] border border-line bg-surface-2 px-3.5 py-3 text-sm text-muted"
          data-testid="portfolio-closed"
        >
          Elinizde varlık kalmadı; geçmiş kayıtlarınız duruyor.
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
          hint="Bugün bozdurursanız yaklaşık"
          emphasis
          testId="stat-liquidation"
        />
        {isSimple ? null : (
          <StatCard
            label={`Yeniden alım değeri${partialSuffix}`}
            value={valuation(summary.totalReplacementValue)}
            hint="Aynısını bugün almanın maliyeti"
            testId="stat-repurchase"
          />
        )}
        <StatCard
          label={isSimple ? "Toplam maliyet" : "Elde kalan maliyet"}
          value={formatMoney(summary.totalRemainingCostBasis)}
          hint="Masraflar dâhil"
          testId="stat-cost"
        />
        {isSimple ? (
          <Card className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Kâr/Zarar{partialSuffix}</p>
            <p
                data-testid="stat-simple-pnl"
                className={cx("stat-value mt-1.5 font-semibold", moneySizeClass(formatSignedMoney(summary.totalPnl)))}
              >
              {priceOk ? (
                <DeltaValue value={summary.totalPnl} formatted={formatSignedMoney(summary.totalPnl)} />
              ) : (
                <span className="text-muted">{PRICE_UNAVAILABLE}</span>
              )}
            </p>
            {/*
              YÜZDE, ÜSTTEKİ SAYIYA AİT OLMALI.
              Kartın büyük rakamı TOPLAM kâr/zarardır (gerçekleşmiş +
              gerçekleşmemiş); motorun verdiği yüzde ise yalnızca elde kalanın
              oranıdır. Satış yapan kullanıcıda ikisi birbirini tutmaz, o yüzden
              yüzde yalnızca hiç satış yokken yazılır. Arayüzde yüzde UYDURULMAZ.
            */}
            <p className="mt-1 text-xs text-muted">
              {summary.totalUnrealizedPnlPercent !== null && priceOk && dec(summary.totalRealizedPnl).isZero()
                ? `Maliyete göre ${formatPercent(summary.totalUnrealizedPnlPercent)}`
                : "Satışlarınız dâhil toplam kâr/zarar"}
            </p>
          </Card>
        ) : (
          <>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                Gerçekleşmemiş kâr/zarar{partialSuffix}
              </p>
              <p
                data-testid="stat-unrealized"
                className={cx("stat-value mt-1.5 font-semibold", moneySizeClass(formatSignedMoney(summary.totalUnrealizedPnl)))}
              >
                {priceOk ? (
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
                  ? `${pnlText} ${formatPercent(summary.totalUnrealizedPnlPercent)}`
                  : pnlText}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                Gerçekleşmiş kâr/zarar
              </p>
              <p
                data-testid="stat-realized"
                className={cx("stat-value mt-1.5 font-semibold", moneySizeClass(formatSignedMoney(summary.totalRealizedPnl)))}
              >
                <DeltaValue value={summary.totalRealizedPnl} formatted={formatSignedMoney(summary.totalRealizedPnl)} />
              </p>
              <p className="mt-1 text-xs text-muted">Sattıklarınızdan kalan kâr/zarar</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                Toplam kâr/zarar{partialSuffix}
              </p>
              <p
                data-testid="stat-total-pnl"
                className={cx("stat-value mt-1.5 font-semibold", moneySizeClass(formatSignedMoney(summary.totalPnl)))}
              >
                {priceOk ? (
                  <DeltaValue value={summary.totalPnl} formatted={formatSignedMoney(summary.totalPnl)} />
                ) : (
                  <span className="text-muted">{PRICE_UNAVAILABLE}</span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted">Sattıklarınız ve elinizdekiler birlikte</p>
            </Card>
          </>
        )}
      </div>

      {/*
        KAPATILABİLİR.

        Bilgilendirme kutusu ekranda sonsuza kadar durmaz; kullanıcı okuyup
        kapatabilir. Kutunun kimliği metinle birlikte sürümlenir (bkz.
        dismissible-notice.tsx), yoksa metin değişince kimse yeni cümleyi görmez.

        Aşağıdaki fiyat uyarıları ise KAPATILAMAZ: onlar ekrandaki sayının neden
        EKSİK olduğunu söyler; kapanırsa kullanıcı eksik bir toplamı tam sanır.
      */}
      {summary.hasEstimatedOrBaseline ? (
        <DismissibleNotice
          id="pnl-tracking-start-v2"
          className="rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3 py-2"
          testId="pnl-label-notice"
        >
          <p className="text-xs leading-relaxed text-muted">
            Bazı altınlarınız gerçek alış fiyatıyla girilmedi; kâr/zarar takibe başladığınız günden
            beri hesaplanıyor.
          </p>
        </DismissibleNotice>
      ) : null}

      {noPrices ? (
        <div
          className="rounded-[var(--radius)] border border-negative-soft bg-negative-soft px-3.5 py-3 text-sm text-negative"
          data-testid="valuation-none"
        >
          Şu anda fiyat alınamadığı için bugünkü değeriniz ve kârınız hesaplanamadı; girdiğiniz
          maliyet değişmedi.
        </div>
      ) : summary.hasMissingPrices ? (
        <div
          className="rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3.5 py-3 text-sm text-[var(--notice)]"
          data-testid="partial-valuation"
        >
          {/* Eksiğin büyüklüğü kalır: kullanıcı eksik toplamı tam portföy değeri sanmasın. */}
          <span className="font-semibold">Eksik fiyat:</span> {summary.unpricedPositionCount} ürünün fiyatı
          alınamadı; yukarıdaki toplamlar bu ürünleri içermiyor (bu ürünlerin maliyeti{" "}
          {formatMoney(summary.unpricedCostBasis)}).
        </div>
      ) : null}

      {/*
        PİYASA KAPALIYKEN: son bilinen fiyat kullanıldı, yaşı YAZILIR.

        Bu bir hata bildirimi değil, tarih bildirimidir; bu yüzden uyarı rengi
        yok. Ama kapatılamaz: sayının hangi ana ait olduğunu söyler, gizlenirse
        kullanıcı cumartesi gördüğü rakamı o anın fiyatı sanar.
      */}
      {isOpen && summary.stalePositionCount > 0 && summary.oldestStaleQuoteAt ? (
        <p className="text-xs text-muted" data-testid="stale-valuation">
          Piyasa kapalı; {summary.stalePositionCount} ürün için son bilinen fiyat kullanıldı
          ({formatDateTime(summary.oldestStaleQuoteAt)} itibarıyla).
        </p>
      ) : null}

      {/*
        Grafik yalnızca elde varlık VARKEN gösterilir: boş portföyde düz sıfır
        çizgisi çizmek bilgi vermez, yer kaplar.
      */}
      {isOpen ? <PortfolioChart /> : null}

      <section>
        <SectionTitle
          title="Varlıklarım"
          description={
            isOpen
              ? // Portföyde hiç altın yoksa (yalnız gümüş/döviz) "0 gr has altın"
                // yazmak yanlış olurdu; o durumda has altın satırı hiç yazılmaz.
                dec(summary.totalPureGoldGrams).greaterThan(0)
                ? `${summary.positionCount} üründe toplam ${formatGrams(summary.totalPureGoldGrams)} has altın`
                : `${summary.positionCount} varlık`
              : undefined
          }
          action={isNeverUsed ? undefined : actionButtons}
        />
        <Card>
          {isNeverUsed ? (
            <EmptyState
              title="Henüz altın eklenmedi"
              description="Altınınızı ekleyin; değeriniz ve kârınız otomatik hesaplansın."
              action={emptyStateButtons}
            />
          ) : isClosed ? (
            // Açıklama satırı yok: aynı cümle kartların üstündeki şeritte yazıyor.
            // Başlık kalır, yoksa listenin yerinde boş bir kutu görünür.
            <EmptyState title="Elinizde varlık kalmadı" description="" />
          ) : (
            <ul data-testid="holdings-list">
              {primaryHoldings.map((holding) => (
                <HoldingRow
                  key={holding.product.id}
                  holding={holding}
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
          <SectionTitle title="Diğer varlıklar" description={`${String(otherHoldings.length)} varlık`} />
          <Card>
            <ul data-testid="other-holdings-list">
              {otherHoldings.map((holding) => (
                <HoldingRow
                  key={holding.product.id}
                  holding={holding}
                  sharedFrom={sharedFrom(holding.product.id)}
                  simple={isSimple}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {/*
        Fiyatın nereden ve ne zaman geldiği sayfada TEK yerde yazar: aşağıdaki
        ince şerit. Plan adı ve sağlayıcı anlatımı kullanıcının hiçbir kararını
        değiştirmiyordu; merak eden menüden /fiyat-kaynagi sayfasına gidebilir.
      */}
      <PriceSourceLine
        snapshot={snapshot}
        dataStatusLabel={repository.label}
        isOnline={isOnline}
        onRefresh={() => void refreshPrices()}
      />
    </div>
  );
}
