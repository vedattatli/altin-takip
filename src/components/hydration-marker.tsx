"use client";

import { useEffect, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * İstemci tarafı etkileşimin hazır olup olmadığını söyler.
 *
 * Sunucu render'ında ve hidrasyon tamamlanana kadar false döner. Kimlik bilgisi
 * içeren formların düğmeleri bu değere göre kilitlenir; böylece hidrasyon
 * tamamlanmadan yapılan bir gönderim tarayıcının varsayılan davranışına düşemez.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Hidrasyon tamamlandığında kök öğeye data-hydrated="true" yazar.
 * Uçtan uca testler etkileşime başlamadan önce bu işareti bekler.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
    return () => {
      delete document.documentElement.dataset.hydrated;
    };
  }, []);

  return null;
}
