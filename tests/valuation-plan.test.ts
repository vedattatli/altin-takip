import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";
import { validateUsableQuote } from "@/prices/validate";
import {
  HYBRID_MARKET_ID,
  HYBRID_PROVIDER_ID,
  isPrimaryProduct,
  KAPALICARSI_PROVIDER_CODE,
  PLAN_PROVIDER_CODES,
  plannedProviderFor,
  PRIMARY_DISPLAY_GROUPS,
  SCREEN_PROVIDER_CODE,
  SHARED_CATEGORY_QUOTE,
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

  /*
   * Bu ürünler için hiçbir kaynak DÜRÜST bir iki yönlü fiyat yayımlamıyor.
   * Ölçüm (2026-09-04):
   *   14 ayar  Kapalıçarşı %32, Altınkaynak %14 makas → alış hurda, satış
   *            işçilikli perakende; Trunçgil %0,1 → referans kuru, tezgâh değil
   *   22 ayar bilezik  kaynaktaki satır 222.238/241.500 → gram fiyatı değil
   *   8 ayar   hiçbir kaynakta yok
   *   özel gramaj külçe  toptan külçe fiyatı STANDART külçeyedir; özel
   *            gramajın primi farklıdır, aynı fiyat yazılamaz
   *
   * Bunları bağlamak "veri var" olmaz, YANLIŞ veri olur.
   */
  it("dürüst iki yönlü fiyatı olmayan ürünler planda YOKTUR", () => {
    for (const productId of ["kulce-ozel-gramaj", "bilezik-22-ayar", "altin-8-ayar", "altin-14-ayar"]) {
      expect(plannedProviderFor(productId), productId).toBeNull();
    }
  });

  it("külçe artık toptan tablosundan fiyatlanır", () => {
    expect(plannedProviderFor("kulce-24-ayar")).toBe("anlik-altin-kapalicarsi");
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
  /*
   * ÜRÜN ADI ARTIK BİRLEŞTİRİLMİYOR.
   *
   * "Yeni Çeyrek" bir zamanlar arayüzde "Çeyrek Altın" diye gösteriliyordu.
   * Sonuç: kullanıcı hangisini eklediğini panelde göremiyor, seçim listesi ile
   * panel farklı adlar yazıyordu. Her ekran artık katalog adını gösterir;
   * grupların kalan tek işi panelin "Varlıklarım / Diğer varlıklar" ayrımıdır.
   */
  it("ürün adı üreten bir yardımcı YOKTUR", () => {
    const source = readFileSync(join(process.cwd(), "src", "prices", "valuation-plan.ts"), "utf8");
    expect(source).not.toMatch(/displayProductName/);
    // Ekranlar katalog adını doğrudan okur.
    for (const file of ["dashboard-view.tsx", "transactions-view.tsx", "ledger-forms.tsx"]) {
      const view = readFileSync(join(process.cwd(), "src", "components", file), "utf8");
      expect(view, file).not.toMatch(/displayProductName/);
    }
  });

  it("grup üyeliği yalnızca panel ayrımı içindir", () => {
    expect(isPrimaryProduct("yeni-ceyrek")).toBe(true);
    expect(isPrimaryProduct("eski-ceyrek")).toBe(true);
    expect(isPrimaryProduct("has-altin")).toBe(false);
  });

  /*
   * İki ekran aynı katalogu gösterir: "Varlık türü" açılır listesi ve fiyat
   * sayfası. Başlık sırası veya adı ayrışırsa kullanıcı aynı ürünü iki farklı
   * yerde farklı bir grupta arar.
   */
  it("seçim listesi ile fiyat sayfası aynı başlık sırasını kullanır", () => {
    const titles = (file: string, constName: string): string[] => {
      const source = readFileSync(join(process.cwd(), "src", "components", file), "utf8");
      const block = source.slice(source.indexOf(`const ${constName}`), source.indexOf("];", source.indexOf(`const ${constName}`)));
      return [...block.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]!);
    };
    const expected = ["Altınlar", "Döviz", "Gümüş"];
    expect(titles("ledger-forms.tsx", "SELECT_GROUPS")).toEqual(expected);
    expect(titles("price-list-view.tsx", "GROUPS")).toEqual(expected);
  });

  it("varsayılan listede tam olarak altı ad vardır", () => {
    const labels = PRIMARY_DISPLAY_GROUPS.map((group) => group.label);
    expect(labels).toEqual(["Gram Altın", "Çeyrek Altın", "Yarım Altın", "Tam Altın", "Ata Altın", "Gremse Altın"]);
  });
});
