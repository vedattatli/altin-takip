/**
 * Beklenen uygulama origin'lerini belirler.
 *
 * - APP_ORIGIN verilmişse YALNIZCA o kabul edilir.
 * - Üretimde APP_ORIGIN ZORUNLUDUR: Host / X-Forwarded-Host başlıklarından
 *   türetme yapılmaz (bu başlıklar istemci tarafından belirlenebilir).
 *   Eksikse boş liste döner ve durum değiştiren istekler fail-closed reddedilir.
 * - Geliştirmede boşsa istek başlıklarından türetilir (yalnızca kolaylık).
 *
 * E2E testleri APP_ORIGIN'i açıkça ayarlar; başka bir "override" yolu yoktur.
 */
export function expectedOrigins(
  headers: { get(name: string): string | null },
  configuredOrigin: string,
  isProduction: boolean,
): string[] {
  let configured = configuredOrigin.trim();
  while (configured.endsWith("/")) configured = configured.slice(0, -1);
  if (configured) return [configured];
  if (isProduction) return [];

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return [];

  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  if (proto) return [`${proto}://${host}`];

  // Protokol bilinmiyorsa her ikisi de kabul edilir; yalnızca yerel geliştirmede olur.
  return [`https://${host}`, `http://${host}`];
}
