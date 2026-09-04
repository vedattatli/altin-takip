"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";

import { cx } from "./ui";

/**
 * BİR KEZ GÖSTERİLİR, KAPATILINCA GERİ GELMEZ.
 *
 * Bilgilendirme kutuları ekranda sonsuza kadar durmamalı. Kullanıcı okuyup
 * kapattıysa mesajı tekrar tekrar göstermek ekranı işgal etmekten başka bir
 * şey yapmaz.
 *
 * NE ZAMAN KULLANILIR: mesaj, ekrandaki bir sayının ANLAMINI taşımıyorsa.
 * Kâr/zarar kutusu bunun sınırındaydı ve kapatılabilir yapıldı, çünkü uyarının
 * özü ("Takip başlangıcından itibaren K/Z") zaten kartın kendi etiketinde
 * yazıyor. Kutu gitse de sayı yanlış okunmuyor.
 *
 * NE ZAMAN KULLANILMAZ: "fiyat verisi kullanılamıyor" gibi, ekrandaki sayının
 * neden EKSİK olduğunu söyleyen uyarılar. Onlar durum bildirir, kapatılamaz.
 *
 * Tercih `localStorage`'ta tutulur — görünüm modu tercihiyle aynı desen.
 * Hassas veri değildir ve cihaz başınadır. Depolama kapalıysa (gizli sekme)
 * kutu her açılışta görünür; sessizce çökmez.
 */

const PREFIX = "altin-takip:notice:";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function isDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(PREFIX + id) === "1";
  } catch {
    return false;
  }
}

function dismiss(id: string): void {
  try {
    window.localStorage.setItem(PREFIX + id, "1");
  } catch {
    // Yazılamazsa kutu bir sonraki açılışta yine görünür; kabul edilebilir.
  }
  for (const listener of listeners) listener();
}

export function DismissibleNotice({
  id,
  children,
  className,
  testId,
}: {
  /** Kalıcı anahtar. Metin değişince yeni bir kimlik verin ki mesaj tekrar görünsün. */
  id: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const getSnapshot = useCallback(() => isDismissed(id), [id]);
  // Sunucuda her zaman "kapatılmamış" render edilir; hidrasyon sonrası düzelir.
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, () => false);

  if (dismissed) return null;

  return (
    <div className={cx("relative", className)} data-testid={testId}>
      <div className="pr-9">{children}</div>
      <button
        type="button"
        onClick={() => dismiss(id)}
        aria-label="Bilgilendirmeyi kapat"
        data-testid={testId ? `${testId}-dismiss` : undefined}
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-lg leading-none text-subtle transition-colors hover:bg-surface-3 hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
