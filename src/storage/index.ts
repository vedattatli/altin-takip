import { IndexedDbPortfolioRepository } from "./indexeddb-repository";
import { MemoryPortfolioRepository } from "./memory-repository";
import { ServerPortfolioRepository } from "./server-repository";
import type { PortfolioRepository } from "./types";

export * from "./types";
export { IndexedDbPortfolioRepository } from "./indexeddb-repository";
export { MemoryPortfolioRepository } from "./memory-repository";
export { ServerPortfolioRepository } from "./server-repository";

export type StorageMode = "account" | "demo";

/**
 * Depo seçimi tek noktadan yapılır.
 * - "account": oturum açmış kullanıcı, sunucu deposu (cihazlar arası senkron).
 * - "demo":    yalnızca geliştirme ortamında, IndexedDB (bu cihaza özel).
 */
export function createRepository(mode: StorageMode): PortfolioRepository {
  if (mode === "account") return new ServerPortfolioRepository();
  if (typeof indexedDB === "undefined") return new MemoryPortfolioRepository();
  return new IndexedDbPortfolioRepository();
}
