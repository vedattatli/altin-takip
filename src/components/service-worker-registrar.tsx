"use client";

import { useEffect } from "react";

/**
 * Servis çalışanını yalnızca üretim derlemesinde VE kişisel cihazda kaydeder.
 *
 * Şirket / ortak cihazda kayıt yapılmaz: hiçbir sayfa yanıtı cihazda önbelleğe
 * alınmaz ve PWA kurulumu için hiçbir çağrı gösterilmez. PWA kurulumu her
 * durumda tamamen isteğe bağlıdır; hiçbir özellik ona bağlı değildir.
 */
export function ServiceWorkerRegistrar({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (!enabled || process.env.NODE_ENV !== "production") {
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
  }, [enabled]);

  return null;
}
