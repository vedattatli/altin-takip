import { NextResponse, type NextRequest } from "next/server";

import { csrfCookieName, csrfSecretOrNull, isProductionRuntime } from "@/server/security/config";
import {
  CSRF_REQUEST_HEADER,
  createSignedCsrfCookie,
  readSignedCsrfCookie,
} from "@/server/security/csrf";

/**
 * CSRF jetonunu üretir ve taşır.
 *
 * Next.js 16'da "middleware" dosya kuralı "proxy" olarak yeniden adlandırıldı;
 * bu dosya yeni kuralı kullanır.
 *
 * - Geçerli imzalı çerez yoksa yenisi üretilir ve HttpOnly çerezde saklanır.
 * - Ham jeton istek başlığıyla sunucu bileşenlerine iletilir; onlar da
 *   sayfaya <meta name="csrf-token"> olarak basar.
 * - Jeton hiçbir zaman localStorage/sessionStorage'a yazılmaz ve çerez
 *   HttpOnly olduğu için document.cookie ile okunamaz.
 */
/**
 * Makine (zamanlanmış görev) uçları.
 *
 * Bu uçlar tarayıcıdan çağrılmaz: oturumları, sayfaları ve dolayısıyla CSRF
 * jetonları yoktur. Onlara çerez yazmak gereksizdir ve "makine yanıtı çerez
 * taşımaz" garantisini bozar.
 */
/**
 * Makine uçları: oturum yok, çerez yok, CSRF jetonu yok. Kimlik yalnızca
 * paylaşılan sır (cron) veya HMAC imzasıdır (worker). Bu yollara çerez
 * basmak, tarayıcı kimliğiyle makine kimliğini karıştırmak olurdu.
 */
const MACHINE_PATHS = ["/api/cron/", "/api/internal/price-worker/"];

export async function proxy(request: NextRequest) {
  if (MACHINE_PATHS.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const secret = csrfSecretOrNull();

  // Üretimde gizli anahtar yoksa jeton üretilmez; durum değiştiren istekler
  // route katmanında zaten açık bir yapılandırma hatasıyla reddedilir.
  if (!secret) return NextResponse.next();

  const name = csrfCookieName();
  const existing = request.cookies.get(name)?.value;

  let token = await readSignedCsrfCookie(existing, secret);
  let issuedCookie: string | null = null;

  if (!token) {
    const issued = await createSignedCsrfCookie(secret);
    token = issued.token;
    issuedCookie = issued.cookieValue;
  }

  const headers = new Headers(request.headers);
  headers.set(CSRF_REQUEST_HEADER, token);

  const response = NextResponse.next({ request: { headers } });

  if (issuedCookie) {
    response.cookies.set(name, issuedCookie, {
      httpOnly: true,
      // __Host- öneki Secure zorunlu kılar; yerel http geliştirmede önek yoktur.
      secure: isProductionRuntime(),
      sameSite: "lax",
      path: "/",
    });
  }

  return response;
}

export const config = {
  matcher: [
    // Statik varlıklar ve servis çalışanı dışındaki her istek.
    "/((?!_next/static|_next/image|favicon.ico|icons/|sw.js|manifest.webmanifest).*)",
  ],
};
