import { getProduct } from "@/domain/catalog";
import type { PriceProvider, PriceProviderMeta, PriceQuote, PriceSnapshot } from "./types";

/**
 * MockPriceProvider — TEST VERİSİ ÜRETİR. GERÇEK PİYASA FİYATI DEĞİLDİR.
 *
 * Gerçek bir siteden veri çekmez, scrape etmez, hiçbir dış servise bağlanmaz.
 * Amacı yalnızca arayüzü ve hesaplamaları doğrulanabilir kılmaktır.
 * Gerçek fiyat entegrasyonu ileride LicensedPriceProvider ile,
 * lisanslı/izinli bir sağlayıcı üzerinden yapılacaktır.
 */

export const MOCK_PROVIDER_META: PriceProviderMeta = {
  id: "mock",
  label: "Test Verisi",
  market: "TEST",
  isRealMarketData: false,
  disclaimer:
    "Bu fiyatlar test amaçlı üretilmiş örnek verilerdir. Gerçek piyasa fiyatı değildir, alım satım kararı için kullanılmamalıdır.",
  staleAfterMs: 5 * 60 * 1000,
};

/** Test verisinin dayandığı has altın gram başlangıç değeri (TL). Gerçek kur değildir. */
const BASE_PURE_GOLD_TRY_PER_GRAM = 5_400;

/** Fiyatın salınım genliği (yüzde). Deterministik dalgalanma üretir. */
const DRIFT_AMPLITUDE = 0.018;

/** Kategori bazlı alış-satış makası (tek yönlü oran). */
const SPREAD_BY_CATEGORY: Record<string, number> = {
  gram: 0.006,
  kulce: 0.008,
  ziynet: 0.014,
  ayarli: 0.035,
};

/** Ziynet altınlarında has değerinin üzerine binen basım/rağbet primi. */
const PREMIUM_BY_CATEGORY: Record<string, number> = {
  gram: 1.0,
  kulce: 1.002,
  ziynet: 1.035,
  ayarli: 0.985,
};

/** Fiyatları 30 saniyelik dilimlere sabitler; aynı dilimde aynı sonuç döner. */
const TICK_MS = 30_000;

function pseudoRandom(seed: number): number {
  // Deterministik, kriptografik olmayan basit karıştırıcı: [-1, 1]
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Test fiyatı iki ondalıklı TL dizesi olarak üretilir; sonrasında kayan nokta hesabına girmez. */
function moneyString(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export interface MockPriceProviderOptions {
  /** Testlerde sabitlenebilir zaman kaynağı. */
  now?: () => number;
  /** Testlerde sabitlenebilir taban fiyat. */
  basePricePerPureGram?: number;
  /** true ise sağlayıcı hata veriyormuş gibi davranır (fallback yapılmadığını doğrulamak için). */
  simulateOutage?: boolean;
}

export class MockPriceProvider implements PriceProvider {
  readonly meta = MOCK_PROVIDER_META;

  private readonly now: () => number;
  private readonly basePrice: number;
  private readonly simulateOutage: boolean;

  constructor(options: MockPriceProviderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.basePrice = options.basePricePerPureGram ?? BASE_PURE_GOLD_TRY_PER_GRAM;
    this.simulateOutage = options.simulateOutage ?? false;
  }

  /** Belirli bir an için has altın gram orta fiyatı (test verisi). */
  private midPurePricePerGram(timestamp: number): number {
    const tick = Math.floor(timestamp / TICK_MS);
    const drift = pseudoRandom(tick) * DRIFT_AMPLITUDE;
    return this.basePrice * (1 + drift);
  }

  async getQuotes(productIds: readonly string[]): Promise<PriceSnapshot> {
    const timestamp = this.now();
    const fetchedAt = new Date(timestamp).toISOString();

    if (this.simulateOutage) {
      // BAŞKA BİR PİYASAYA GEÇİLMEZ. Fiyat yoksa yok denir.
      return {
        provider: this.meta,
        quotes: {},
        fetchedAt,
        status: "unavailable",
        error: "Fiyat kaynağına şu anda ulaşılamıyor. Değerleme gösterilmiyor.",
      };
    }

    const providerTimestamp = new Date(Math.floor(timestamp / TICK_MS) * TICK_MS).toISOString();
    const mid = this.midPurePricePerGram(timestamp);
    const quotes: Record<string, PriceQuote> = {};
    let missing = 0;

    for (const productId of productIds) {
      const product = getProduct(productId);
      if (!product) {
        missing += 1;
        continue;
      }

      const spread = SPREAD_BY_CATEGORY[product.category] ?? 0.01;
      const premium = PREMIUM_BY_CATEGORY[product.category] ?? 1;
      const unitMid = mid * product.pureGoldPerUnit * premium;

      quotes[productId] = {
        productId,
        // Bozdurma her zaman ortanın altında, yeniden alım her zaman üstünde.
        liquidationPrice: moneyString(unitMid * (1 - spread)),
        replacementPrice: moneyString(unitMid * (1 + spread)),
        currency: "TRY",
        market: this.meta.market,
        provider: this.meta.id,
        providerTimestamp,
        fetchedAt,
        status: "ok",
      };
    }

    const requested = productIds.length;
    const delivered = Object.keys(quotes).length;

    return {
      provider: this.meta,
      quotes,
      fetchedAt,
      status: delivered === 0 && requested > 0 ? "unavailable" : missing > 0 ? "partial" : "ok",
      error:
        missing > 0
          ? "Bazı ürünler için test fiyatı üretilemedi. Bu ürünler değerlemeye dâhil edilmedi."
          : null,
    };
  }
}
