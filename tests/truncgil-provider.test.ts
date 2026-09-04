import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TruncgilProvider } from "@/prices/providers/truncgil-provider";
import { TRUNCGIL_MAPPING } from "@/prices/providers/mappings";

/**
 * TRUNCGIL ADAPTER'I
 *
 * Kanıtlanan şeyler:
 *  - `Type` alanına güvenilmez: kaynak GUMUS/XU100/BRENT satırlarını da
 *    "Gold" etiketliyor. Beyaz liste dışı hiçbir sembol ürüne yazılmaz.
 *  - Tek yönlü satırdan çift fiyat uydurulmaz.
 *  - Şekil değişirse fail closed olunur; esnek okuma yapılmaz.
 *  - Ortam kapısı kapalıyken hiçbir fiyat üretilmez.
 */

const ENV_KEYS = [
  "APP_DEPLOYMENT_ENV",
  "PRICE_EXPERIMENTAL_SARRAF_SCREEN",
  "PRICE_EXPERIMENTAL_PRIVATE_PILOT",
];

function openGate(): void {
  process.env.APP_DEPLOYMENT_ENV = "private-pilot";
  process.env.PRICE_EXPERIMENTAL_SARRAF_SCREEN = "true";
  process.env.PRICE_EXPERIMENTAL_PRIVATE_PILOT = "true";
}

/** Gerçek yanıtın şekli. Gümüş ve endeks satırları KASTEN "Gold" etiketli. */
const PAYLOAD = {
  Update_Date: "2026-09-04 06:21:01",
  USD: { Buying: 48.43, Selling: 48.45, Type: "Currency" },
  GRA: { Buying: 6965.69, Selling: 6966.56, Type: "Gold" },
  HAS: { Buying: 6930.86, Selling: 6931.73, Type: "Gold" },
  CEYREKALTIN: { Buying: 11040.76, Selling: 11294.89, Type: "Gold" },
  YARIMALTIN: { Buying: 22012.52, Selling: 22589.78, Type: "Gold" },
  TAMALTIN: { Buying: 44163.05, Selling: 45041.39, Type: "Gold" },
  ATAALTIN: { Buying: 45543.15, Selling: 46699.36, Type: "Gold" },
  // Bunlar ALTIN DEĞİL ama kaynak "Gold" diyor:
  GUMUS: { Buying: 103.83, Selling: 103.92, Type: "Gold" },
  XU100: { Buying: null, Selling: 13932.46, Type: "Gold" },
  BRENT: { Buying: null, Selling: 0, Type: "Gold" },
  ONS: { Buying: 0, Selling: 0, Type: "Gold" },
};

function providerWith(payload: unknown, ok = true): TruncgilProvider {
  return new TruncgilProvider({
    fetchImpl: (async () =>
      ({
        ok,
        json: async () => payload,
      }) as unknown as Response) as unknown as typeof fetch,
  });
}

describe("1. ortam kapısı", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("kapı kapalıyken lisanssız görünür ve fiyat üretmez", async () => {
    const provider = providerWith(PAYLOAD);
    expect(provider.licenseStatus()).toBe("NOT_CONFIGURED");
    const snapshot = await provider.fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("özel pilotta EXPERIMENTAL_PRIVATE olur; LİSANSLI olmaz", () => {
    openGate();
    expect(providerWith(PAYLOAD).licenseStatus()).toBe("EXPERIMENTAL_PRIVATE");
  });
});

describe("2. sembol beyaz listesi", () => {
  beforeEach(openGate);
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("gümüş ve endeks satırları ALTIN ÜRÜNÜNE YAZILMAZ", async () => {
    const snapshot = await providerWith(PAYLOAD).fetchSnapshot([]);
    const ids = snapshot.quotes.map((quote) => quote.canonicalProductId);
    // Kaynak bunları "Gold" etiketliyor; yine de girmemeliler.
    expect(ids).not.toContain("gumus");
    expect(ids.some((id) => id.includes("gumus") || id.includes("xu100"))).toBe(false);
    expect(ids).toContain("gram-altin");
  });

  it("beyaz listedeki her sembol kanonik ürüne çözülür", () => {
    for (const productId of Object.values(TRUNCGIL_MAPPING)) {
      expect(productId).toMatch(/^[a-z0-9-]+$/u);
    }
  });

  it("sıfır veya null fiyatlı satır ATLANIR", async () => {
    const snapshot = await providerWith(PAYLOAD).fetchSnapshot([]);
    for (const quote of snapshot.quotes) {
      expect(Number(quote.liquidationPrice)).toBeGreaterThan(0);
      expect(Number(quote.replacementPrice)).toBeGreaterThan(0);
    }
  });

  it("eski ziynetler aynı kaynak fiyatını GROUPED olarak alır", async () => {
    const snapshot = await providerWith(PAYLOAD).fetchSnapshot([]);
    const yeni = snapshot.quotes.find((q) => q.canonicalProductId === "yeni-ceyrek");
    const eski = snapshot.quotes.find((q) => q.canonicalProductId === "eski-ceyrek");
    expect(yeni?.liquidationPrice).toBe(eski?.liquidationPrice);
    expect(yeni?.replacementPrice).toBe(eski?.replacementPrice);
  });
});

describe("3. alış/satış yönü", () => {
  beforeEach(openGate);
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("Buying bozdurmaya, Selling yeniden alıma yazılır; ters çevrilmez", async () => {
    const snapshot = await providerWith(PAYLOAD).fetchSnapshot([]);
    const ceyrek = snapshot.quotes.find((q) => q.canonicalProductId === "yeni-ceyrek");
    expect(ceyrek?.liquidationPrice).toBe("11040.76");
    expect(ceyrek?.replacementPrice).toBe("11294.89");
    // Bozdurma her zaman yeniden alımdan DÜŞÜK olmalıdır.
    expect(Number(ceyrek?.liquidationPrice)).toBeLessThan(Number(ceyrek?.replacementPrice));
  });
});

describe("4. sözleşme değişirse fail closed", () => {
  beforeEach(openGate);
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("Update_Date yoksa fiyat ÜRETİLMEZ", async () => {
    const snapshot = await providerWith({ GRA: { Buying: 1, Selling: 2 } }).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.safeErrorCode).toBe("CONTRACT_MISMATCH");
  });

  it("alan adları değişirse fiyat ÜRETİLMEZ", async () => {
    // "Buying/Selling" yerine "alis/satis" gelirse esnek okuma YAPILMAZ.
    const snapshot = await providerWith({
      Update_Date: "2026-09-04 06:21:01",
      GRA: { alis: 6965.69, satis: 6966.56, Type: "Gold" },
    }).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("HTTP hatasında başka kaynağa DÜŞÜLMEZ", async () => {
    const snapshot = await providerWith(PAYLOAD, false).fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.quotes).toHaveLength(0);
  });

  it("yanıt nesne değilse fiyat ÜRETİLMEZ", async () => {
    const snapshot = await providerWith("bozuk").fetchSnapshot([]);
    expect(snapshot.status).toBe("unavailable");
  });
});
