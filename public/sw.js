/*
 * Altın Takip — servis çalışanı (uygulama kabuğu).
 *
 * GÜVENLİK KURALLARI
 * - /api/* istekleri ASLA önbelleğe alınmaz. Oturum ve portföy verisi hep ağdan gelir.
 * - Kimliği doğrulanmış SAYFA yanıtları da önbelleğe ALINMAZ. Ortak cihazda bir
 *   sonraki kullanıcının önbellekten hassas ekran görmesi bu sayede imkânsızdır.
 *   Önbellekte yalnızca statik varlıklar ve çevrimdışı bilgi sayfası tutulur.
 * - Çevrimdışıyken canlı fiyat varmış gibi davranılmaz; kullanıcı çevrimdışı
 *   sayfasına yönlendirilir.
 * - Bu servis çalışanı yalnızca "Kişisel cihaz" modunda kaydedilir. Ortak cihazda
 *   kayıt silinir ve tüm önbellekler temizlenir (bkz. src/components/device-guard.tsx).
 * - PWA kurulumu tamamen isteğe bağlıdır; hiçbir özellik servis çalışanına bağlı değildir.
 */
const VERSION = "altin-takip-v2";
const SHELL_CACHE = VERSION + "-shell";
const OFFLINE_URL = "/cevrimdisi";

const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API yanıtları hiçbir koşulda önbelleğe alınmaz.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Sayfa yanıtları ağdan gelir ve ÖNBELLEĞE YAZILMAZ.
    // Ağ yoksa yalnızca statik çevrimdışı bilgi sayfası gösterilir.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Statik varlıklar (hassas veri içermez): önce önbellek, sonra ağ.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Yalnızca başarılı yanıt önbelleğe alınır. Önbellek-önce dal olduğu için
          // 404/5xx bir kez yazılırsa VERSION elle değişene kadar kalıcı olarak servis edilir.
          if (!response.ok) return response;
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        });
      }),
    );
  }
});
