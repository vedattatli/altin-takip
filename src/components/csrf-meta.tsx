import { headers } from "next/headers";

import { CSRF_REQUEST_HEADER } from "@/server/security/csrf";

/**
 * CSRF jetonunu sayfaya basar.
 *
 * Jeton proxy katmanında üretilir ve istek başlığıyla buraya taşınır.
 * İstemci bu meta etiketini okuyup X-CSRF-Token başlığında geri gönderir;
 * jeton hiçbir tarayıcı deposuna yazılmaz.
 *
 * Yalnızca durum değiştiren istek yapan sayfalarda kullanılır; statik
 * sayfalar (çevrimdışı, 404) headers() okumaz ve prerender edilebilir kalır.
 */
export async function CsrfMeta() {
  const token = (await headers()).get(CSRF_REQUEST_HEADER);
  if (!token) return null;
  return <meta name="csrf-token" content={token} />;
}
