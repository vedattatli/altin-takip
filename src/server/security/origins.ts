/**
 * Beklenen uygulama origin'lerini belirler.
 *
 * APP_ORIGIN verilmişse yalnızca o kabul edilir (üretim için önerilen yol).
 * Verilmemişse istek başlıklarından (X-Forwarded-Host / Host) türetilir;
 * bu yalnızca geliştirme kolaylığı içindir.
 */
export function expectedOrigins(
  headers: { get(name: string): string | null },
  configuredOrigin: string,
): string[] {
  if (configuredOrigin) return [configuredOrigin.replace(/\/+$/, "")];

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return [];

  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  if (proto) return [`${proto}://${host}`];

  // Protokol bilinmiyorsa her ikisi de kabul edilir; yalnızca yerel geliştirmede olur.
  return [`https://${host}`, `http://${host}`];
}
