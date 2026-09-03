import type { ProviderId } from "../contract";

/**
 * DOĞRULANMIŞ SAĞLAYICI SÖZLEŞMELERİ
 *
 * Taslak JSON adapter'ı (`PrototypeJsonProvider`) birden çok alan adını deneyen
 * ESNEK bir okuyucudur. Böyle bir okuyucu, sözleşmesi doğrulanmamış bir API'de
 * sessizce yanlış sütunu okuyabilir; alış/satış ters düşerse kullanıcı yanlış
 * kâr/zarar görür. Bu yüzden "URL ve API anahtarı girildi" bir sağlayıcıyı
 * üretim adapter'ı yapmaya YETMEZ.
 *
 * Bir sağlayıcının üretimde etkinleşebilmesi için İKİ koşul birden gerekir:
 *
 *  1. KODDA fixture: aşağıdaki listede o sağlayıcı için bir sözleşme sürümü
 *     bulunmalıdır. Liste yalnızca, yanıt şekli commit edilmiş bir fixture
 *     testiyle doğrulanmış sürümleri içerir.
 *  2. ORTAMDA beyan: operatör `*_CONTRACT_VERSION` değişkenine aynı sürümü
 *     yazarak elindeki sözleşmenin bu şekle uyduğunu açıkça beyan eder.
 *
 * İkisinden biri eksikse sağlayıcı NOT_CONFIGURED kalır.
 *
 * NOT: Buradaki sürümler gerçek bir sağlayıcı sözleşmesi DEĞİLDİR; yalnızca
 * `tests/price-providers.test.ts` içindeki fixture'larla doğrulanmış genel JSON
 * şekilleridir. Gerçek sözleşme geldiğinde sağlayıcıya özgü bir sürüm ve kendi
 * fixture'ı eklenir.
 */
export interface VerifiedContract {
  version: string;
  /**
   * Sözleşme, uçtan YALNIZCA TL fiyat döndüğünü açıkça garanti ediyor mu?
   *
   * false ise para birimi yanıttan OKUNMAK ZORUNDADIR. Bu ayrım bilinçlidir:
   * "para birimi alanı yoksa TRY varsay" davranışı, yabancı para dönen bir ucu
   * sessizce TL sanmamıza yol açardı.
   */
  currencyFixedToTry: boolean;
  description: string;
}

const GENERIC_JSON: VerifiedContract = {
  version: "generic-json-1",
  currencyFixedToTry: false,
  description:
    "Genel JSON şekli: symbol/bid/ask/timestamp/currency. Para birimi yanıtta bulunmak zorundadır.",
};

const GENERIC_JSON_TRY: VerifiedContract = {
  version: "generic-json-try-1",
  currencyFixedToTry: true,
  description:
    "Genel JSON şekli; sözleşme ucun YALNIZCA TL fiyat döndürdüğünü garanti ettiği için para birimi alanı zorunlu değildir.",
};

export const VERIFIED_CONTRACTS: Partial<Record<ProviderId, readonly VerifiedContract[]>> = {
  altinapi: [GENERIC_JSON, GENERIC_JSON_TRY],
  hasfiyat: [GENERIC_JSON, GENERIC_JSON_TRY],
  // sarraf-pro-kayseri: yetkili API/XML sözleşmesi bekleniyor — bilerek yok.
};

/** Beyan edilen sürümün doğrulanmış karşılığı (yoksa null). */
export function findVerifiedContract(providerId: ProviderId, version: string): VerifiedContract | null {
  const known = VERIFIED_CONTRACTS[providerId];
  if (!known) return null;
  const wanted = version.trim();
  return known.find((contract) => contract.version === wanted) ?? null;
}
