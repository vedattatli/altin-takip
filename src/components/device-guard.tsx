"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

import { type DeviceMode, resolveIdleTimeoutMs } from "@/auth/types";
import { apiFetch } from "@/lib/api-client";

/**
 * Şirket / ortak cihaz kısıtlarını uygular.
 *
 * Paylaşılan cihazda:
 *  - 15 dakika hareketsizlikte otomatik çıkış yapılır,
 *  - servis çalışanı kaydı KALDIRILIR ve önbellekler temizlenir
 *    (hassas sayfa yanıtları cihazda kalmasın diye),
 *  - PWA kurulum çağrısı bastırılır,
 *  - hiçbir cihaz izni (bildirim, konum vb.) istenmez.
 *
 * Kişisel cihazda bu kısıtlar uygulanmaz; uygulamanın görsel ve işlevsel
 * davranışı iki modda da aynıdır.
 */

/** Süre üretimde her zaman 15 dakikadır; yalnızca test kaçış kapısıyla kısaltılabilir. */
function idleTimeoutMs(): number {
  return resolveIdleTimeoutMs({
    allowTestOverrides: process.env.NEXT_PUBLIC_ALLOW_TEST_OVERRIDES,
    overrideMs: process.env.NEXT_PUBLIC_SHARED_IDLE_MS,
  });
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

export function DeviceGuard({
  deviceMode,
  authenticated,
}: {
  deviceMode: DeviceMode;
  /** Hareketsizlik sayacı yalnızca açık bir oturum varken çalışır. */
  authenticated: boolean;
}) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signingOutRef = useRef(false);

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/giris?sebep=zaman-asimi");
      router.refresh();
    }
  }, [router]);

  // Hareketsizlik sayacı — yalnızca ortak cihazda ve açık oturumda.
  useEffect(() => {
    if (deviceMode !== "shared" || !authenticated) return;

    const timeout = idleTimeoutMs();
    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void signOut(), timeout);
    };

    reset();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    document.addEventListener("visibilitychange", reset);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [deviceMode, authenticated, signOut]);

  // Ortak cihazda hiçbir şey cihazda bırakılmaz.
  useEffect(() => {
    if (deviceMode !== "shared") return;

    const suppressInstallPrompt = (event: Event) => event.preventDefault();
    window.addEventListener("beforeinstallprompt", suppressInstallPrompt);

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) void registration.unregister();
      });
    }
    if ("caches" in globalThis) {
      void caches.keys().then((keys) => {
        for (const key of keys) void caches.delete(key);
      });
    }

    return () => window.removeEventListener("beforeinstallprompt", suppressInstallPrompt);
  }, [deviceMode]);

  return null;
}
