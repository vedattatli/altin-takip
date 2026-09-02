import type { SessionPolicy } from "@/auth/types";

/**
 * Oturum çerezi seçenekleri.
 *
 * - HttpOnly: jeton JavaScript'ten okunamaz.
 * - Secure: HTTPS üzerinde her zaman açıktır (yerel http geliştirme hariç).
 * - SameSite=Lax: siteler arası istekle gönderilmez.
 * - Path=/ ve Domain YOK: üretimdeki __Host- öneki bunu zorunlu kılar.
 * - Şirket / ortak cihazda çerez KALICI DEĞİLDİR: son kullanma tarihi
 *   verilmez, böylece tarayıcı kapandığında oturum silinir. Asıl güvenlik
 *   sınırı yine de sunucudaki idle/absolute süre kontrolüdür.
 */
export function sessionCookieOptions(expiresAt: string, policy: SessionPolicy, secure: boolean) {
  const base = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  if (!policy.persistentCookie) return base;
  return { ...base, expires: new Date(expiresAt) };
}
