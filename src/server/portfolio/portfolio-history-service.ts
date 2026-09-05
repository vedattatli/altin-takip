import "server-only";

import { replayLedger } from "@/domain/accounting";
import { dec } from "@/domain/accounting/decimal";
import type { LedgerEntry } from "@/domain/accounting/types";
import { PLAN_PROVIDER_CODES, plannedProviderFor, SHARED_CATEGORY_QUOTE } from "@/prices/valuation-plan";
import { ownScope, type UserActor } from "@/server/auth/actor";
import type { AuthBackend } from "@/server/auth/backend";
import type { PriceHistoryRow } from "@/server/prices/types";

/**
 * PORTFÖY DEĞERİ ZAMAN SERİSİ — SABİT ARALIKLI (MUM MANTIĞI)
 *
 * Seçilen aralık, "son şu kadar süre" DEĞİLDİR; grafiğin KIRILIM adımıdır.
 * Borsa arayüzlerindeki 15m / 1H / 4H / 1D / 1W ile aynı anlam: 1H seçilince
 * grafik en baştan itibaren saatlik kovalara bölünür ve her kovanın KAPANIŞ
 * değeri tek bir nokta olur. Noktalar sonra birleştirilerek çizgi çizilir.
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
 *
 * BOŞ KOVA UYDURULMAZ
 * Fiyat ~5-10 dakikada bir toplanıyor. 15 dakikalık kovaların çoğunda gözlem
 * vardır, ama toplayıcı gecikirse bir kova BOŞ kalabilir. Boş kova için nokta
 * ÜRETİLMEZ; çizgide boşluk kalır ve kaç kovanın boş olduğu (`emptyIntervals`)
 * arayüze bildirilir. Boş kovayı bir öncekinin değeriyle doldurmak, olmayan bir
 * ölçümü varmış gibi göstermek olurdu.
 *
 * KOVA KAPANIŞI = KOVADAKİ SON GÖZLEM
 * Değer, kovanın nominal bitiş saatinde değil, o kovaya düşen SON gözlemin
 * anında hesaplanır. Nominal bitişi kullanmak, gözlemi 12:03'te olan bir kovayı
 * 12:15 fiyatıymış gibi etiketlerdi.
 */

/** Bir fiyat en fazla bu kadar süre "hâlâ geçerli" sayılıp ileri taşınır. */
const MAX_CARRY_FORWARD_MS = 3 * 60 * 60_000;

/**
 * Grafikte tek seferde döndürülen en fazla nokta sayısı.
 *
 * Geriye bakış süresi bundan TÜRETİLİR: `aralık × MAX_POINTS`. Yani 1H'de
 * ~20 gün, 1D'de ~500 gün görünür. Borsa arayüzleri de ekranda sabit sayıda
 * mum tutar; sabit bir "şu kadar gün" tablosu uydurmaya gerek yok.
 */
const MAX_POINTS = 500;

/**
 * Kova sınırları Türkiye saatine göre hizalanır (UTC+3, yıl boyu sabit).
 * Aksi hâlde "1 günlük" kova gece 03:00'te kapanır ve günlük grafik kullanıcının
 * takvim gününe denk gelmezdi.
 */
const TR_OFFSET_MS = 3 * 60 * 60_000;

export type HistoryInterval = "15m" | "1h" | "4h" | "1d" | "1w";

/**
 * ARALIK LİSTESİ NEDEN 15 DAKİKADAN BAŞLIYOR
 *
 * Fiyat ücretsiz bulut görevinden ~5-10 dakikada bir geliyor. 1m veya 1s
 * aralığı sunmak, olmayan bir çözünürlüğü varmış gibi göstermek olurdu:
 * kovaların çoğu boş çıkar, grafik delik deşik olur. 15 dakika, verinin
 * gerçekten desteklediği en küçük adımdır.
 */
const INTERVAL_MS: Readonly<Record<HistoryInterval, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export function isHistoryInterval(value: unknown): value is HistoryInterval {
  return typeof value === "string" && value in INTERVAL_MS;
}

/** Bir anın ait olduğu kovanın başlangıcı (Türkiye saatine hizalı). */
function bucketStart(at: number, intervalMs: number): number {
  return Math.floor((at + TR_OFFSET_MS) / intervalMs) * intervalMs - TR_OFFSET_MS;
}

export interface HistoryPoint {
  /** Kovanın BAŞLANGICI (ISO). X ekseni bunu kullanır. */
  at: string;
  /** Değerin hesaplandığı gerçek gözlem anı (kovadaki son gözlem). */
  observedAt: string;
  /** Bozdurma değeri (ondalık dize). */
  liquidationValue: string;
  /** Bu noktada fiyatı bulunan ürün sayısı. */
  pricedProducts: number;
  /** Elde olup fiyatı bulunamayan ürün sayısı. 0 değilse nokta kısmidir. */
  missingProducts: number;
  /** Bu kovaya düşen gözlem sayısı. */
  observations: number;
}

export interface PortfolioHistory {
  interval: HistoryInterval;
  points: HistoryPoint[];
  /** Ardışık iki GÖZLEM arasındaki ortanca süre (ms). Verinin gerçek sıklığı. */
  medianStepMs: number | null;
  /** Çizilen aralıkta hiç gözlem düşmeyen kova sayısı (çizgideki boşluklar). */
  emptyIntervals: number;
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
  async series(actor: UserActor, interval: HistoryInterval): Promise<PortfolioHistory> {
    const scope = ownScope(actor);
    const now = this.now();
    const intervalMs = INTERVAL_MS[interval];
    const since = new Date(now - intervalMs * MAX_POINTS).toISOString();

    const [entries, rows] = await Promise.all([
      this.backend.listLedger(scope),
      this.backend.priceQuoteHistory(PLAN_PROVIDER_CODES, since),
    ]);

    const timelines = buildTimelines(rows);
    if (timelines.size === 0) {
      return {
        interval,
        points: [],
        medianStepMs: null,
        emptyIntervals: 0,
        empty: true,
        ledgerChangesInRange: 0,
      };
    }

    // Gerçek gözlem anları. Kovalar bunlardan türetilir; zaman ÜRETİLMEZ.
    const stamps = new Set<number>();
    for (const timeline of timelines.values()) {
      for (const point of timeline.points) stamps.add(point.at);
    }
    const observed = [...stamps].sort((a, b) => a - b);

    /*
     * KOVALAMA: her gözlem ait olduğu kovaya düşer, kovanın DEĞERİ o kovadaki
     * SON gözlemden gelir. Aynı kovadaki daha eski gözlemler çizilmez — mum
     * kapanışı gibi. Kaç gözlem düştüğü sayılır ki kullanıcı seçtiği aralığın
     * veriden daha ince olup olmadığını görebilsin.
     */
    const buckets = new Map<number, { last: number; count: number }>();
    for (const at of observed) {
      const start = bucketStart(at, intervalMs);
      const existing = buckets.get(start);
      if (existing) {
        existing.last = at;
        existing.count += 1;
      } else {
        buckets.set(start, { last: at, count: 1 });
      }
    }
    const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

    const points: HistoryPoint[] = [];
    for (const [start, bucket] of ordered) {
      const at = bucket.last;
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
        at: new Date(start).toISOString(),
        observedAt: new Date(at).toISOString(),
        liquidationValue: total.toFixed(2),
        pricedProducts: priced,
        missingProducts: missing,
        observations: bucket.count,
      });
    }

    /*
     * ÇİZGİDEKİ BOŞLUKLAR: ilk ve son nokta arasında KAÇ kova olması
     * gerekiyordu ile kaç nokta çizildiği arasındaki fark. Kullanıcı "15
     * dakikalık seçtim ama çizgi kopuk" dediğinde cevabı burada.
     */
    let emptyIntervals = 0;
    if (points.length >= 2) {
      const first = Date.parse(points[0]!.at);
      const last = Date.parse(points[points.length - 1]!.at);
      const expected = Math.round((last - first) / intervalMs) + 1;
      emptyIntervals = Math.max(0, expected - points.length);
    }

    // Yalnızca ÇİZİLEN pencere sayılır: grafikte görünmeyen bir işlem çizgiyi
    // de kırmaz, dolayısıyla uyarı gerektirmez.
    const from = points.length > 0 ? Date.parse(points[0]!.observedAt) : 0;
    const to = points.length > 0 ? Date.parse(points[points.length - 1]!.observedAt) : 0;
    const ledgerChangesInRange =
      points.length < 2
        ? 0
        : entries.filter((entry) => {
            if (entry.status !== "ACTIVE") return false;
            const instant = Date.parse(entry.occurredAtInstant);
            return Number.isFinite(instant) && instant > from && instant <= to;
          }).length;

    return {
      interval,
      points,
      // Verinin GERÇEK sıklığı ham gözlemlerden ölçülür, kovalardan değil.
      medianStepMs: medianStep(observed),
      emptyIntervals,
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

function medianStep(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) gaps.push(times[index]! - times[index - 1]!);
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? Math.round((gaps[middle - 1]! + gaps[middle]!) / 2) : gaps[middle]!;
}
