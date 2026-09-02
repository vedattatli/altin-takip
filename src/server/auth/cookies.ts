/**
 * Oturum çerezi seçenekleri.
 *
 * - HttpOnly: jeton JavaScript'ten okunamaz.
 * - Secure: HTTPS üzerinde her zaman açıktır (yerel http geliştirme hariç).
 * - SameSite=Lax: siteler arası istekle gönderilmez.
 * - Path=/ ve Domain YOK: üretimdeki __Host- öneki bunu zorunlu kılar.
 * - KALICI: son kullanma tarihi oturumun sunucudaki bitiş zamanıdır. Tarayıcı
 *   kapatılıp açıldığında, PWA yeniden başlatıldığında veya cihaz yeniden
 *   başladığında oturum devam eder. Sunucu süreyi uzattıkça çerez de tazelenir.
 */
export function sessionCookieOptions(expiresAt: string, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}
