"use client";

import { useCallback, useSyncExternalStore } from "react";

import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { MARKET_DISPLAY_NAMES } from "@/prices/contract";
import { isSnapshotStale, type PriceSnapshot } from "@/prices";
import { SCREEN_PROVIDER_CODE } from "@/prices/valuation-plan";
import { cx } from "./ui";

/**
 * Piyasa kimliği kullanıcıya HAM gösterilmez ("kayseri" yerine "Kayseri Yerel Piyasa").
 * Bilinmeyen/eski değerler olduğu gibi bırakılır; uydurma ad üretilmez.
 */
export function marketLabel(market: string | undefined): string {
  if (!market) return "—";
  // Eski kayıtlar piyasayı büyük harfle tutabilir ("TEST"); eşleme harf durumuna
  // duyarsızdır ki aynı kaynak her yerde AYNI adla görünsün.
  const key = market.toLowerCase() as keyof typeof MARKET_DISPLAY_NAMES;
  return MARKET_DISPLAY_NAMES[key] ?? market;
}

const SERVER_CLOCK = () => null;

/**
 * İstemci tarafında belirli aralıklarla ilerleyen saat.
 * Sunucuda null döner; böylece göreli zaman metni hidrasyonu bozmaz.
 */
export function useClientClock(intervalMs: number): number | null {
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
 * görünür kalır: fiyatın ne zaman güncellendiği, bayatladıysa uyarısı ve
 * gerçek piyasa verisi olmadığı uyarısı. Uzun yasal açıklama katlanmış durur.
 */
export function PriceSourceLine({
  snapshot,
  isOnline,
  onRefresh,
  syncStatus = "off",
}: {
  snapshot: PriceSnapshot | null;
  /**
   * Verinin nerede saklandığının adı ("Hesabınız"). Şeritte GÖSTERİLMEZ:
   * fiyat cümlesinin ortasında tek başına duran bu kelime hiçbir cümlenin
   * parçası değildi. Bilgi, başlığıyla birlikte Ayarlar'daki "Veri saklama"
   * satırında durur. Prop yalnızca çağıranların imzası için kabul edilir.
   */
  dataStatusLabel?: string;
  isOnline: boolean;
  onRefresh?: () => void;
  syncStatus?: "off" | "idle" | "syncing" | "paused" | "error";
}) {
  const now = useClientClock(30_000);
  const stale = snapshot && now !== null ? isSnapshotStale(snapshot, now) : false;
  const unavailable = !snapshot || snapshot.status === "unavailable";
  // Ekran gözlemi kaynağı kendi fiyat zamanını YAYIMLAMIYOR; elimizde yalnızca
  // gözlem anımız var. Bunu "kaynak zamanı" gibi göstermek yanıltıcı olurdu.
  // Hibrit planda anlık görüntünün kimliği SANALDIR ("hibrit-kayseri"); ekran
  // kaynağı yalnızca ürün başına plan girdisinde görünür. Bu yüzden hem anlık
  // görüntünün kimliğine hem de plan üyelerine bakılır — yoksa koşul üretimde
  // hiç tutmaz ve gözlem anı "kaynak fiyat zamanı" gibi sunulur.
  const observedOnly =
    snapshot?.provider.id === SCREEN_PROVIDER_CODE ||
    Object.values(snapshot?.provider.memberProviders ?? {}).some(
      (member) => member.provider === SCREEN_PROVIDER_CODE,
    );
  const relativeTime =
    snapshot && now !== null ? formatRelativeTime(snapshot.fetchedAt, now) : null;

  return (
    <div data-testid="price-source" className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-subtle">
        <span
          className={cx(stale && "text-[var(--notice)]")}
          title={snapshot ? formatDateTime(snapshot.fetchedAt) : undefined}
        >
          {observedOnly
            ? `Son ekran gözlemi: ${relativeTime ?? "—"}`
            : relativeTime
              ? `Fiyatlar: ${relativeTime} güncellendi`
              : "Fiyatlar: —"}
          {/* Renk tek bilgi taşıyıcı olamaz; eskimiş fiyat METİNLE de söylenir. */}
          {stale ? " · fiyat eskimiş" : ""}
        </span>

        {/*
          UYARI YALNIZ UYDURMA VERİ İÇİNDİR.
          Lisanssız olmak ile gerçek olmamak ayrı şeylerdir: Kayseri tezgâh
          fiyatı gerçektir ama lisanslı değildir. Lisans notu aşağıdaki
          açıklama bölümünde durur.
        */}
        {snapshot?.provider.isTestData === true ? (
          <span className="badge badge-notice">Gerçek piyasa verisi değil</span>
        ) : null}

        {/*
          Eşitleme bilgisi yalnızca ARIZA hâlinde taşıyıcıdır: o zaman kullanıcı
          başka cihazında girdiği kaydın burada görünmeyebileceğini bilmelidir.
          Normal işleyişte ilerleyen sayaç hiçbir karar doğurmuyordu.
        */}
        {syncStatus === "error" ? (
          <>
            <Dot />
            <span
              data-testid="sync-status"
              data-sync-status={syncStatus}
              className="text-[var(--notice)]"
            >
              Kayıtlarınız şu an diğer cihazlarınıza aktarılamıyor
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
          Şu an fiyat alınamıyor; portföyünüzün güncel değeri hesaplanamadı.
        </p>
      ) : null}

      {!isOnline ? (
        <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3 py-2 text-xs font-medium text-[var(--notice)]">
          İnternet bağlantısı yok; ekrandaki fiyatlar güncellenmiyor.
        </p>
      ) : null}
    </div>
  );
}
