/**
 * User-Agent'tan KABA ve kullanıcı dostu bir cihaz etiketi üretir.
 *
 * Ham User-Agent, IP veya cihaz parmak izi SAKLANMAZ; yalnızca bu etiket
 * (örn. "Chrome · Windows") oturum kaydına yazılır ve yönetici / kullanıcı
 * ekranlarında "hangi cihaz" sorusuna yardımcı olur.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua.trim()) return "Bilinmeyen cihaz";
  return `${browserName(ua)} · ${platformName(ua)}`;
}

function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/CriOS\//.test(ua)) return "Chrome";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return "Tarayıcı";
}

function platformName(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Bilinmeyen sistem";
}
