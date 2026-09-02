import { MockPriceProvider } from "./mock-provider";
import type { PriceProvider } from "./types";

export * from "./types";
export { MockPriceProvider, MOCK_PROVIDER_META } from "./mock-provider";

/**
 * Aktif fiyat sağlayıcı.
 *
 * Bu sürümde YALNIZCA test sağlayıcısı kullanılır. Gerçek fiyat entegrasyonu
 * (LicensedPriceProvider) lisanslı bir sağlayıcı sözleşmesi olmadan eklenmez;
 * hiçbir siteden izinsiz veri çekilmez.
 *
 * Bir sağlayıcı çalışmadığında başka bir piyasanın fiyatına SESSİZCE geçilmez.
 */
let cached: PriceProvider | null = null;

export function getPriceProvider(): PriceProvider {
  if (!cached) cached = new MockPriceProvider();
  return cached;
}

/** Testlerde sağlayıcıyı değiştirmek için. */
export function setPriceProvider(provider: PriceProvider | null): void {
  cached = provider;
}
