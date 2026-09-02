import { SNAPSHOT_FUTURE_TOLERANCE_MS } from "@/prices/types";
import { dec } from "./decimal";
import type { PriceSnapshotInput } from "./types";

/**
 * FİYAT ANLIK GÖRÜNTÜSÜ DOĞRULAMASI (MARKET_BASELINE)
 *
 * Sunucu sağlayıcısından gelen fiyat bile deftere yazılmadan önce denetlenir; aynı
 * kurallar Postgres `ledger_append` içinde uygulanır. Kural dışı anlık görüntüyle
 * takip başlangıcı OLUŞTURULMAZ; başka ürün/piyasadan sessiz ikame yapılmaz.
 */

/** Anlık görüntünün takip başlangıcı için kabul edildiği en uzun yaş. */
export const BASELINE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export const SNAPSHOT_CURRENCY = "TRY";

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function positiveDecimal(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return false;
  return dec(value).greaterThan(0);
}

/** Geçerliyse null, aksi hâlde kullanıcıya gösterilebilir Türkçe hata. */
export function validatePriceSnapshotInput(
  snapshot: PriceSnapshotInput | null | undefined,
  productId: string,
  now: number,
): string | null {
  if (!snapshot) return "Başlangıç fiyatı anlık görüntüsü eksik.";
  if (snapshot.productId !== productId) {
    return "Fiyat anlık görüntüsü başka bir ürüne ait; takip başlangıcı oluşturulamaz.";
  }
  if (snapshot.providerStatus !== "ok") return "Fiyat verisi kullanılamıyor; takip başlangıcı oluşturulamaz.";
  if (typeof snapshot.provider !== "string" || snapshot.provider.trim() === "") return "Fiyat sağlayıcısı belirsiz.";
  if (typeof snapshot.market !== "string" || snapshot.market.trim() === "") return "Fiyat piyasası belirsiz.";
  if (snapshot.currency !== SNAPSHOT_CURRENCY) return "Fiyat para birimi TL olmalıdır.";
  if (!positiveDecimal(snapshot.liquidationPrice)) return "Bozdurma fiyatı geçersiz.";
  if (!positiveDecimal(snapshot.replacementPrice)) return "Yeniden alım fiyatı geçersiz.";
  if (dec(snapshot.replacementPrice).lessThan(dec(snapshot.liquidationPrice))) {
    return "Fiyat makası tutarsız: yeniden alım fiyatı bozdurma fiyatından düşük olamaz.";
  }
  const providerTs = parseInstant(snapshot.providerTimestamp);
  const fetchedAt = parseInstant(snapshot.fetchedAt);
  if (providerTs === null || fetchedAt === null) return "Fiyat zamanı geçersiz.";
  if (providerTs > now + SNAPSHOT_FUTURE_TOLERANCE_MS || fetchedAt > now + SNAPSHOT_FUTURE_TOLERANCE_MS) {
    return "Fiyat zamanı gelecekte; anlık görüntü reddedildi.";
  }
  if (now - fetchedAt > BASELINE_SNAPSHOT_MAX_AGE_MS) {
    return "Fiyat verisi bayat; takip başlangıcı oluşturulamaz.";
  }
  return null;
}
