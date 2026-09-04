import "server-only";

import { replayLedger } from "@/domain/accounting";
import { dec } from "@/domain/accounting/decimal";
import type { LedgerEntry } from "@/domain/accounting/types";
import { PLAN_PROVIDER_CODES, plannedProviderFor, SHARED_CATEGORY_QUOTE } from "@/prices/valuation-plan";
import { ownScope, type UserActor } from "@/server/auth/actor";
import type { AuthBackend } from "@/server/auth/backend";
import type { PriceHistoryRow } from "@/server/prices/types";

/**
 * PORTFÖY DEĞERİ ZAMAN SERİSİ
 *
 * Grafik VERİ UYDURMAZ. Nokta sıklığı, fiyatın gerçekte toplandığı sıklıktır;
 * noktaların arası doldurulmaz, düzleştirilmez, interpolasyon yapılmaz. Fiyat
 * 10 dakikada bir geliyorsa grafik 10 dakikada bir kırılır — kripto grafiği
 * gibi akmaz ve akıyormuş gibi de gösterilmez.
 *
 * KURALLAR
 *  1. Her noktada pozisyon, O ANA KADARKİ deftere göre yeniden oynatılır.
 *     "Bugünkü portföyü geçmiş fiyatlarla çarpmak" YANLIŞ olurdu: dün elde
 *     olmayan altını dünkü grafikte göstermek geçmişi çarpıtır.
 *  2. Her ürünün fiyatı YALNIZCA planlanmış sağlayıcısından gelir
 *     (`valuation-plan.ts`). Kaynak karıştırılmaz.
 *  3. O anda fiyatı olmayan ürün noktaya KATILMAZ ve nokta "kısmi" işaretlenir.
 *     Eksik ürünü sıfır saymak toplam değeri düşük gösterirdi.
 *  4. Fiyat ileriye taşınır ama sonsuza kadar değil: `MAX_CARRY_FORWARD_MS`.
 *     Kaynak sustuğunda son fiyat sabit çizgi olarak uzatılmaz.
 *  5. Aralık içinde alım/satım yapıldıysa bu AÇIKÇA bildirilir
 *     (`ledgerChangesInRange`). Portföy değerindeki sıçrama o zaman fiyat
 *     hareketi DEĞİL, para giriş/çıkışıdır; grafiğin altındaki değişim rakamı
 *     "kâr" gibi okunamaz.
 */

/** Bir fiyat en fazla bu kadar süre "hâlâ geçerli" sayılıp ileri taşınır. */
const MAX_CARRY_FORWARD_MS = 3 * 60 * 60_000;

/** Grafikte tek seferde döndürülen en fazla nokta sayısı. */
const MAX_POINTS = 500;

export type HistoryRange = "1h" | "24h" | "7d" | "30d";

const RANGE_MS: Readonly<Record<HistoryRange, number>> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === "string" && value in RANGE_MS;
}

export interface HistoryPoint {
  /** Gözlem anı (ISO). Kaynağın kendi fiyat saati değil; bkz. OBSERVED politikası. */
  at: string;
  /** Bozdurma değeri (ondalık dize). */
  liquidationValue: string;
  /** Bu noktada fiyatı bulunan ürün sayısı. */
  pricedProducts: number;
  /** Elde olup fiyatı bulunamayan ürün sayısı. 0 değilse nokta kısmidir. */
  missingProducts: number;
}

export interface PortfolioHistory {
  range: HistoryRange;
  points: HistoryPoint[];
  /** Ardışık iki nokta arasındaki ORTANCA süre (ms). Kullanıcıya "veri sıklığı". */
  medianStepMs: number | null;
  /** Hiç fiyat geçmişi yoksa true: grafik yerine açıklama gösterilir. */
  empty: boolean;
  /**
   * Çizilen aralıkta kaç AKTİF defter kaydı var (alış, satış, mevcut ekleme).
   *
   * Sıfırdan büyükse ilk-son farkı yalnızca fiyat hareketi değildir: kullanıcı
   * bu aralıkta varlık eklemiş veya çıkarmıştır. Arayüz bunu bilmeden farkı
   * yeşil bir "kâr" gibi gösterirdi — 50.000 TL'lik bir alım "+%500 kazanç"
   * diye okunurdu.
   */
  ledgerChangesInRange: number;
}

interface PriceTimeline {
  /** Zamana göre artan; her giriş [ms, liquidationPrice]. */
  points: { at: number; liquidation: string }[];
}

/** Bir ürünün planlanmış sağlayıcısındaki fiyat çizgisi. */
function buildTimelines(rows: readonly PriceHistoryRow[]): Map<string, PriceTimeline> {
  const byProduct = new Map<string, PriceTimeline>();
  for (const row of rows) {
    const planned = plannedProviderFor(row.canonicalProductId);
    // Plan dışı sağlayıcıdan gelen fiyat o ürüne YAZILMAZ.
    if (planned === null || planned !== row.providerCode) continue;
    const at = Date.parse(row.observedAt);
    if (!Number.isFinite(at)) continue;
    const timeline = byProduct.get(row.canonicalProductId) ?? { points: [] };
    timeline.points.push({ at, liquidation: row.liquidationPrice });
    byProduct.set(row.canonicalProductId, timeline);
  }
  for (const timeline of byProduct.values()) timeline.points.sort((a, b) => a.at - b.at);
  return byProduct;
}

/** T anında ve öncesinde bilinen en yeni fiyat; taşıma sınırı aşılırsa null. */
function priceAt(timeline: PriceTimeline | undefined, at: number): string | null {
  if (!timeline) return null;
  let found: { at: number; liquidation: string } | null = null;
  for (const point of timeline.points) {
    if (point.at > at) break;
    found = point;
  }
  if (found === null) return null;
  if (at - found.at > MAX_CARRY_FORWARD_MS) return null;
  return found.liquidation;
}

/** Ekranın yeni/eski ayrımı yayımlamadığı ürünler ortak kategori fiyatını kullanır. */
function timelineFor(
  timelines: Map<string, PriceTimeline>,
  productId: string,
): PriceTimeline | undefined {
  const own = timelines.get(productId);
  if (own) return own;
  const shared = SHARED_CATEGORY_QUOTE[productId];
  return shared === undefined ? undefined : timelines.get(shared);
}

export class PortfolioHistoryService {
  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Kapsam BURADA kurulur, route'ta değil: `ownScope` yalnızca servis
   * katmanında çağrılır (tests/authorization-matrix.test.ts bunu denetler).
   * Böylece hiçbir uç gövdeden/sorgudan hedef kullanıcı alamaz.
   */
  async series(actor: UserActor, range: HistoryRange): Promise<PortfolioHistory> {
    const scope = ownScope(actor);
    const now = this.now();
    const since = new Date(now - RANGE_MS[range]).toISOString();

    const [entries, rows] = await Promise.all([
      this.backend.listLedger(scope),
      this.backend.priceQuoteHistory(PLAN_PROVIDER_CODES, since),
    ]);

    const timelines = buildTimelines(rows);
    if (timelines.size === 0) {
      return { range, points: [], medianStepMs: null, empty: true, ledgerChangesInRange: 0 };
    }

    // Nokta zamanları: gerçekte gözlem yapılan anlar. Eşit aralığa ZORLANMAZ.
    const stamps = new Set<number>();
    for (const timeline of timelines.values()) {
      for (const point of timeline.points) stamps.add(point.at);
    }
    const ordered = [...stamps].sort((a, b) => a - b);
    // Sınır aşılırsa eşit aralıkla seyreltilir; EN YENİ nokta her zaman kalır.
    const sampled = thin(ordered, MAX_POINTS);

    const points: HistoryPoint[] = [];
    for (const at of sampled) {
      const upTo = entriesUpTo(entries, at);
      const positions = replayLedger(upTo);

      let total = dec(0);
      let priced = 0;
      let missing = 0;
      for (const position of positions.values()) {
        const quantity = dec(position.quantity);
        if (!quantity.greaterThan(0)) continue;
        const unitPrice = priceAt(timelineFor(timelines, position.productId), at);
        if (unitPrice === null) {
          missing += 1;
          continue;
        }
        total = total.plus(quantity.times(dec(unitPrice)));
        priced += 1;
      }

      // Elde hiç ürün yoksa nokta anlamlıdır (değer 0); ama elde ürün varken
      // hiçbirinin fiyatı yoksa nokta ATLANIR — "0 TL" yanlış bilgi olurdu.
      if (priced === 0 && missing > 0) continue;

      points.push({
        at: new Date(at).toISOString(),
        liquidationValue: total.toFixed(2),
        pricedProducts: priced,
        missingProducts: missing,
      });
    }

    // Yalnızca ÇİZİLEN pencere sayılır: grafikte görünmeyen bir işlem çizgiyi
    // de kırmaz, dolayısıyla uyarı gerektirmez.
    const from = points.length > 0 ? Date.parse(points[0]!.at) : 0;
    const to = points.length > 0 ? Date.parse(points[points.length - 1]!.at) : 0;
    const ledgerChangesInRange =
      points.length < 2
        ? 0
        : entries.filter((entry) => {
            if (entry.status !== "ACTIVE") return false;
            const instant = Date.parse(entry.occurredAtInstant);
            return Number.isFinite(instant) && instant > from && instant <= to;
          }).length;

    return {
      range,
      points,
      medianStepMs: medianStep(points.map((point) => Date.parse(point.at))),
      empty: points.length === 0,
      ledgerChangesInRange,
    };
  }
}

/** `occurredAtInstant` <= at olan kayıtlar; sıralama defterin kendi sırasıdır. */
function entriesUpTo(entries: readonly LedgerEntry[], at: number): LedgerEntry[] {
  return entries.filter((entry) => {
    const instant = Date.parse(entry.occurredAtInstant);
    return Number.isFinite(instant) && instant <= at;
  });
}

/** Eşit aralıkla seyreltir; ilk ve SON nokta korunur. */
function thin(values: readonly number[], max: number): number[] {
  if (values.length <= max) return [...values];
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let index = 0; index < max; index += 1) {
    out.push(values[Math.round(index * step)]!);
  }
  // Yuvarlama yüzünden tekrar eden değer kalabilir.
  return [...new Set(out)];
}

function medianStep(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) gaps.push(times[index]! - times[index - 1]!);
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? Math.round((gaps[middle - 1]! + gaps[middle]!) / 2) : gaps[middle]!;
}
