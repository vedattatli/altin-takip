import { SNAPSHOT_FUTURE_TOLERANCE_MS } from "@/prices/types";
import { dec } from "./decimal";
import type { PriceSnapshotInput } from "./types";

/**
 * FİYAT ANLIK GÖRÜNTÜSÜ DOĞRULAMASI (MARKET_BASELINE)
 *
 * Sunucu sağlayıcısından gelen fiyat bile deftere yazılmadan önce denetlenir; AYNI
 * kurallar Postgres `ledger_append` içinde uygulanır (aynı girdi → aynı sonuç):
 *  - ürün eşleşmesi, status = ok, sağlayıcı/piyasa boş değil, para birimi TL
 *  - liquidation > 0, replacement > 0, replacement >= liquidation
 *  - providerTimestamp ve fetchedAt geçerli; toleransı (5 dk) aşacak biçimde gelecekte değil
 *  - providerTimestamp VE fetchedAt en fazla staleAfterMs (bildirilmemişse 15 dk) eski
 *    ("veri şimdi çekilmiş görünse bile sağlayıcı zamanı eskiyse" reddedilir)
 *  - fetchedAt, providerTimestamp'tan (toleransın ötesinde) önce olamaz
 * Kural dışı anlık görüntüyle takip başlangıcı OLUŞTURULMAZ; başka ürün/piyasadan sessiz
 * ikame yapılmaz. Quote düzeyi (sağlayıcı meta ile) doğrulama için bkz. src/prices/validate.ts.
 */

/** Sağlayıcı kendi bayatlık süresini bildirmediğinde kullanılan varsayılan en uzun yaş. */
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

/**
 * Etkin tazelik sınırı: sağlayıcının kendi bayatlık süresi (yoksa varsayılan).
 *
 * Burada AYRI/daha dar bir üst sınır uygulanmaz: arayüz kapısı (src/prices/validate.ts)
 * ürünün kendi staleAfterMs değerini kullandığı için, buraya ikinci bir sınır konursa
 * ekranda "Güncel" görünüp fiyatı gösterilen bir kotasyon gönderimde reddedilir ve
 * kullanıcı gördüğü fiyatla kayıt açamaz. İki kapı aynı eşiği kullanmalıdır.
 */
export function baselineMaxAgeMs(staleAfterMs: number | undefined): number {
  if (typeof staleAfterMs === "number" && Number.isFinite(staleAfterMs) && staleAfterMs > 0) {
    return staleAfterMs;
  }
  return BASELINE_SNAPSHOT_MAX_AGE_MS;
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
  const maxAge = baselineMaxAgeMs(snapshot.staleAfterMs);
  if (now - fetchedAt > maxAge) {
    return "Fiyat verisi bayat; takip başlangıcı oluşturulamaz.";
  }
  if (now - providerTs > maxAge) {
    return "Sağlayıcı fiyat zamanı eski; veri yeni çekilmiş görünse bile takip başlangıcı oluşturulamaz.";
  }
  if (fetchedAt < providerTs - SNAPSHOT_FUTURE_TOLERANCE_MS) {
    return "Fiyat, sağlayıcı zamanından önce çekilmiş görünüyor; veri tutarsız.";
  }
  return null;
}
