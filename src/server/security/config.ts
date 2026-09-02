/**
 * CSRF yapılandırması — hem middleware (Edge) hem route handler'lar kullanır.
 * Bu modül bilinçli olarak "server-only" içe aktarmaz; proxy (eski adıyla
 * middleware) çalışma zamanında da yüklenebilmelidir.
 */

/** Geliştirmede sabit gizli anahtar; üretimde AUTH_CSRF_SECRET ZORUNLUDUR. */
export const DEV_CSRF_SECRET = "gelistirme-ortami-csrf-gizli-anahtari";

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Üretimde __Host- öneki kullanılır: tarayıcı bu öneki yalnızca Secure,
 * Path=/ ve Domain'siz çerezlerde kabul eder.
 */
export function csrfCookieName(): string {
  return isProductionRuntime() ? "__Host-altin_takip_csrf" : "altin_takip_csrf";
}

export function sessionCookieName(): string {
  const configured = (process.env.AUTH_SESSION_COOKIE ?? "").trim();
  if (configured) return configured;
  return isProductionRuntime() ? "__Host-altin_takip_session" : "altin_takip_session";
}

/** Üretimde gizli anahtar yoksa null döner; çağıran taraf hata üretir. */
export function csrfSecretOrNull(): string | null {
  const configured = (process.env.AUTH_CSRF_SECRET ?? "").trim();
  if (configured) return configured;
  return isProductionRuntime() ? null : DEV_CSRF_SECRET;
}
