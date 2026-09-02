"use client";

import { useEffect } from "react";

/**
 * Servis çalışanını yalnızca üretim derlemesinde kaydeder.
 *
 * PWA kurulumu her durumda tamamen isteğe bağlıdır; hiçbir özellik ona bağlı
 * değildir. Servis çalışanı /api/* yanıtlarını ve kimliği doğrulanmış sayfaları
 * ASLA önbelleğe almaz (bkz. public/sw.js); yalnızca statik varlıklar ve
 * çevrimdışı bilgi sayfası saklanır.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) void registration.unregister();
      });
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Kayıt başarısız olursa uygulama normal çalışmaya devam eder.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
