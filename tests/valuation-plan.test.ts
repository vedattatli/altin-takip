import { describe, expect, it } from "vitest";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";
import { validateUsableQuote } from "@/prices/validate";
import {
  displayProductName,
  HYBRID_MARKET_ID,
  HYBRID_PROVIDER_ID,
  isPrimaryProduct,
  KAPALICARSI_PROVIDER_CODE,
  PLAN_PROVIDER_CODES,
  plannedProviderFor,
  PRIMARY_DISPLAY_GROUPS,
  SCREEN_PROVIDER_CODE,
  SHARED_CATEGORY_QUOTE,
  summarizeSources,
  TURKIYE_PROVIDER_CODE,
  VALUATION_SOURCE_PLAN,
} from "@/prices/valuation-plan";

/**
 * HİBRİT DEĞERLEME PLANI
 *
 * Bu testler tek bir soruyu koruyor: bir ürünün fiyatı, planda yazandan
 * BAŞKA bir kaynaktan gelebilir mi? Cevap her koşulda hayır olmalı.
 */

const NOW = Date.parse("2026-09-04T08:00:00.000Z");
const FRESH = "2026-09-04T07:30:00.000Z";
const STALE_MS = 90 * 60_000;

function quote(overrides: Partial<PriceQuote> & { productId: string }): PriceQuote {
  return {
    liquidationPrice: "1000",
    replacementPrice: "1100",
    currency: "TRY",
    market: "kayseri",
    provider: SCREEN_PROVIDER_CODE,
    providerTimestamp: FRESH,
    fetchedAt: FRESH,
    status: "ok",
    ...overrides,
  };
}

function hybridSnapshot(
  quotes: readonly PriceQuote[],
  members: Record<string, { provider: string; market: string; sharedFrom?: string }>,
): PriceSnapshot {
  return {
    provider: {
      id: HYBRID_PROVIDER_ID,
      label: "Hibrit Kayseri Değerlemesi",
      market: HYBRID_MARKET_ID,
      isRealMarketData: false,
      disclaimer: "",
      staleAfterMs: STALE_MS,
      memberProviders: Object.fromEntries(
        Object.entries(members).map(([productId, member]) => [
          productId,
          { ...member, staleAfterMs: STALE_MS },
        ]),
      ),
    },
    quotes: Object.fromEntries(quotes.map((entry) => [entry.productId, entry])),
    fetchedAt: FRESH,
    status: "ok",
    error: null,
  };
}

describe("1. plan bütünlüğü", () => {
  it("altı ana ürünün her birinin TEK bir kaynağı vardır", () => {
    expect(PRIMARY_DISPLAY_GROUPS).toHaveLength(6);
    for (const group of PRIMARY_DISPLAY_GROUPS) {
      const provider = plannedProviderFor(group.primaryProductId);
      expect(provider, group.label).not.toBeNull();
      expect(PLAN_PROVIDER_CODES).toContain(provider!);
    }
  });

  it("planda yalnızca katalogda gerçekten bulunan ürünler vardır", () => {
    const known = new Set(GOLD_PRODUCTS.map((product) => product.id));
    for (const productId of Object.keys(VALUATION_SOURCE_PLAN)) {
      expect(known.has(productId), productId).toBe(true);
    }
  });

  it("ortak kategori fiyatı yalnızca AYNI kaynaktan alınabilir", () => {
    for (const [member, primary] of Object.entries(SHARED_CATEGORY_QUOTE)) {
      expect(plannedProviderFor(member)).toBe(plannedProviderFor(primary));
    }
  });

  it("gram ve ata için beklenen kaynaklar yazılıdır", () => {
    // Ölçüm sonucu: ekranda gram altının İKİ YÖNLÜ satırı yok, Ata'nınki var.
    expect(plannedProviderFor("gram-altin")).toBe(KAPALICARSI_PROVIDER_CODE);
    expect(plannedProviderFor("ata-altin")).toBe(SCREEN_PROVIDER_CODE);
    expect(plannedProviderFor("yeni-ceyrek")).toBe(SCREEN_PROVIDER_CODE);
    expect(plannedProviderFor("yeni-yarim")).toBe(SCREEN_PROVIDER_CODE);
    expect(plannedProviderFor("yeni-tam")).toBe(SCREEN_PROVIDER_CODE);
    expect(plannedProviderFor("gremse-altin")).toBe(SCREEN_PROVIDER_CODE);
  });

  it("hiçbir kaynakta iki yönlü fiyatı olmayan ürünler planda YOKTUR", () => {
    for (const productId of ["kulce-24-ayar", "kulce-ozel-gramaj", "bilezik-22-ayar", "altin-8-ayar"]) {
      expect(plannedProviderFor(productId), productId).toBeNull();
    }
  });
});

describe("2. kaynak karıştırma imkânsızdır", () => {
  it("planlanan kaynaktan gelen fiyat kabul edilir", () => {
    const snapshot = hybridSnapshot(
      [quote({ productId: "yeni-ceyrek", provider: SCREEN_PROVIDER_CODE, market: "kayseri" })],
      { "yeni-ceyrek": { provider: SCREEN_PROVIDER_CODE, market: "kayseri" } },
    );
    const result = validateUsableQuote(snapshot, snapshot.quotes["yeni-ceyrek"], "yeni-ceyrek", NOW);
    expect(result.ok).toBe(true);
  });

  it("BAŞKA kaynaktan gelen fiyat aynı ürüne yazılamaz", () => {
    // Çeyrek planı Sarraf TV der; Kapalıçarşı fiyatı gelirse REDDEDİLİR.
    const snapshot = hybridSnapshot(
      [quote({ productId: "yeni-ceyrek", provider: KAPALICARSI_PROVIDER_CODE, market: "kapalicarsi" })],
      { "yeni-ceyrek": { provider: SCREEN_PROVIDER_CODE, market: "kayseri" } },
    );
    const result = validateUsableQuote(snapshot, snapshot.quotes["yeni-ceyrek"], "yeni-ceyrek", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("provider_mismatch");
  });

  it("planda ADI GEÇMEYEN ürün değerlemeye giremez", () => {
    const snapshot = hybridSnapshot(
      [quote({ productId: "bilezik-22-ayar", provider: SCREEN_PROVIDER_CODE, market: "kayseri" })],
      { "yeni-ceyrek": { provider: SCREEN_PROVIDER_CODE, market: "kayseri" } },
    );
    const result = validateUsableQuote(snapshot, snapshot.quotes["bilezik-22-ayar"], "bilezik-22-ayar", NOW);
    expect(result.ok).toBe(false);
  });

  it("piyasa kimliği planla uyuşmazsa reddedilir", () => {
    const snapshot = hybridSnapshot(
      [quote({ productId: "gram-altin", provider: KAPALICARSI_PROVIDER_CODE, market: "turkiye-genel" })],
      { "gram-altin": { provider: KAPALICARSI_PROVIDER_CODE, market: "kapalicarsi" } },
    );
    const result = validateUsableQuote(snapshot, snapshot.quotes["gram-altin"], "gram-altin", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("market_mismatch");
  });

  it("alış ve satış tek kayıttan gelir; ayrı sağlayıcıya bölünemez", () => {
    // Sözleşme gereği bir quote hem alışı hem satışı taşır. Bu testin amacı
    // yapının bunu MÜMKÜN KILMADIĞINI sabitlemek.
    const entry = quote({ productId: "gremse-altin" });
    expect(Object.keys(entry)).toContain("liquidationPrice");
    expect(Object.keys(entry)).toContain("replacementPrice");
    expect(entry.provider).toBe(SCREEN_PROVIDER_CODE);
  });

  it("bayat fiyat kendi kaynağının eşiğiyle ölçülür", () => {
    const old = "2026-09-04T05:00:00.000Z"; // 3 saat önce
    const snapshot = hybridSnapshot(
      [quote({ productId: "yeni-ceyrek", providerTimestamp: old, fetchedAt: old })],
      { "yeni-ceyrek": { provider: SCREEN_PROVIDER_CODE, market: "kayseri" } },
    );
    const result = validateUsableQuote(snapshot, snapshot.quotes["yeni-ceyrek"], "yeni-ceyrek", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("stale");
  });

  it("plan yoksa eski tek-sağlayıcı kuralı aynen işler", () => {
    const snapshot: PriceSnapshot = {
      provider: {
        id: TURKIYE_PROVIDER_CODE,
        label: "Türkiye",
        market: "turkiye-genel",
        isRealMarketData: false,
        disclaimer: "",
        staleAfterMs: STALE_MS,
      },
      quotes: {
        "gram-altin": quote({ productId: "gram-altin", provider: TURKIYE_PROVIDER_CODE, market: "turkiye-genel" }),
      },
      fetchedAt: FRESH,
      status: "ok",
      error: null,
    };
    expect(validateUsableQuote(snapshot, snapshot.quotes["gram-altin"], "gram-altin", NOW).ok).toBe(true);
  });
});

describe("3. görünüm grupları", () => {
  it("yeni ve eski ziynet tek adla gösterilir", () => {
    expect(displayProductName("yeni-ceyrek", "Yeni Çeyrek")).toBe("Çeyrek Altın");
    expect(displayProductName("eski-ceyrek", "Eski Çeyrek")).toBe("Çeyrek Altın");
    expect(displayProductName("yeni-tam", "Yeni Tam")).toBe("Tam Altın");
  });

  it("aynı gruptan iki kayıt varsa satırlar ayırt edilebilir", () => {
    expect(displayProductName("eski-ceyrek", "Eski Çeyrek", { distinguish: true })).toBe(
      "Çeyrek Altın (Eski Çeyrek)",
    );
    // Tek üyeli grupta parantez EKLENMEZ.
    expect(displayProductName("gram-altin", "Gram Altın", { distinguish: true })).toBe("Gram Altın");
  });

  it("grup dışı ürün katalog adıyla görünür", () => {
    expect(isPrimaryProduct("has-altin")).toBe(false);
    expect(displayProductName("has-altin", "Has Altın")).toBe("Has Altın");
  });

  it("varsayılan listede tam olarak altı ad vardır", () => {
    const labels = PRIMARY_DISPLAY_GROUPS.map((group) => group.label);
    expect(labels).toEqual(["Gram Altın", "Çeyrek Altın", "Yarım Altın", "Tam Altın", "Ata Altın", "Gremse Altın"]);
  });
});

describe("4. kaynak özeti", () => {
  it("kaç ürünün hangi kaynaktan geldiğini sayar", () => {
    const text = summarizeSources([
      SCREEN_PROVIDER_CODE,
      SCREEN_PROVIDER_CODE,
      SCREEN_PROVIDER_CODE,
      SCREEN_PROVIDER_CODE,
      KAPALICARSI_PROVIDER_CODE,
    ]);
    expect(text).toContain("4 ürün Kayseri — Sarraf TV");
    expect(text).toContain("1 ürün Kapalıçarşı — Anlık Altın");
  });

  it("fiyat yoksa boş metin döner", () => {
    expect(summarizeSources([])).toBe("");
  });
});
