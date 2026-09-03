import { MockPriceProvider } from "./mock-provider";
import type { PriceProvider } from "./types";

export * from "./types";
export * from "./validate";
export * from "./contract";
export * from "./descriptors";
export * from "./registry";
export * from "./quality";
export { MockPriceProvider, MOCK_PROVIDER_META } from "./mock-provider";

/**
 * Aktif fiyat sağlayıcı.
 *
 * Bu sürümde YALNIZCA test sağlayıcısı kullanılır. Gerçek fiyat entegrasyonu
 * (LicensedPriceProvider) lisanslı bir sağlayıcı sözleşmesi olmadan eklenmez;
 * hiçbir siteden izinsiz veri çekilmez.
 *
 * Bir sağlayıcı çalışmadığında başka bir piyasanın fiyatına SESSİZCE geçilmez.
 *
 * TEST KANCASI: `PRICE_MOCK_UNAVAILABLE_PRODUCTS="resat-altin,hamit-altin"` ortam
 * değişkeni test sağlayıcısının belirli ürünler için fiyat ÜRETMEMESİNİ sağlar
 * (kısmi / hiç fiyat yok durumlarının uçtan uca testi). Gerçek sağlayıcıda etkisizdir.
 */
let cached: PriceProvider | null = null;

function unavailableProductsFromEnv(): string[] {
  const raw = typeof process !== "undefined" ? (process.env.PRICE_MOCK_UNAVAILABLE_PRODUCTS ?? "") : "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getPriceProvider(): PriceProvider {
  if (!cached) cached = new MockPriceProvider({ unavailableProducts: unavailableProductsFromEnv() });
  return cached;
}

/** Testlerde sağlayıcıyı değiştirmek için. */
export function setPriceProvider(provider: PriceProvider | null): void {
  cached = provider;
}
