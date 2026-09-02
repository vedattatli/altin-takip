/**
 * Oturum çerezi seçenekleri.
 *
 * - HttpOnly: jeton JavaScript'ten okunamaz.
 * - Secure: HTTPS üzerinde her zaman açıktır (yerel http geliştirme hariç).
 * - SameSite=Lax: siteler arası istekle gönderilmez.
 * - Path=/ ve Domain YOK: üretimdeki __Host- öneki bunu zorunlu kılar.
 * - persistent=true ("Bu cihazda oturumumu açık tut"): son kullanma tarihi
 *   sunucudaki kaydırmalı bitiştir; tarayıcı kapanınca çerez kalır.
 * - persistent=false: tarayıcı oturumu çerezi — son kullanma tarihi VERİLMEZ,
 *   tarayıcı kapanınca silinir. Sunucu ayrıca 8 saat mutlak + hareketsizlik
 *   sınırını uygular; güvenlik sınırı her zaman sunucudadır.
 */
export function sessionCookieOptions(expiresAt: string, secure: boolean, persistent: boolean) {
  const base = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  if (!persistent) return base;
  return { ...base, expires: new Date(expiresAt) };
}
