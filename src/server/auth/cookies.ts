import type { DeviceMode } from "@/auth/types";

/**
 * Oturum çerezi seçenekleri.
 *
 * - HttpOnly: jeton JavaScript'ten okunamaz.
 * - Secure: HTTPS üzerinde her zaman açıktır (yerel http geliştirme hariç).
 * - SameSite=Lax: siteler arası istekle gönderilmez.
 * - Şirket / ortak cihazda çerez KALICI DEĞİLDİR: son kullanma tarihi verilmez,
 *   böylece tarayıcı kapandığında oturum silinir.
 */
export function sessionCookieOptions(expiresAt: string, deviceMode: DeviceMode, secure: boolean) {
  const base = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  if (deviceMode === "shared") return base;
  return { ...base, expires: new Date(expiresAt) };
}
