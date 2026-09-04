"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * GÖRÜNÜM MODU — BASİT / DETAYLI
 *
 * Basit mod VARSAYILANDIR ve günlük kullanım için tasarlanmıştır:
 * altın ekle, portföyünü gör, kâr/zararını gör. Satış ekleme, gerçekleşmiş
 * kâr/zarar ayrımı ve fiyat kaynağı ayrıntıları gizlenir.
 *
 * NE GİZLENİR, NE GİZLENMEZ
 * Gizlenen şeyler yalnızca ARAYÜZ ayrıntılarıdır. Muhasebe motoru, kayıtlar
 * ve hesaplama aynen çalışır; basit modda hiçbir kayıt silinmez veya
 * değişmez. Fiyatın bayat/kullanılamaz olduğunu söyleyen uyarılar da
 * GİZLENMEZ: bunlar süs değil, yanlış sonuç çıkarmayı önleyen bilgilerdir.
 *
 * Tercih yalnızca bu tarayıcıda saklanır. Sunucuya gitmez, başka cihaza
 * taşınmaz; bir görünüm tercihidir, hesap ayarı değildir.
 *
 * NEDEN `useSyncExternalStore`
 * Tercih React'in dışında (tarayıcı deposunda) yaşıyor. Efekt içinde okuyup
 * setState çağırmak zincirleme render üretirdi; bu API tam da bu iş için var
 * ve sunucu anlık görüntüsünü ayrıca alarak hidrasyon uyuşmazlığını önler.
 */

export type ViewMode = "basit" | "detayli";

const STORAGE_KEY = "altin-takip:gorunum-modu";
const DEFAULT_MODE: ViewMode = "basit";

/** Aynı sekmedeki değişiklikleri dinleyenler ("storage" olayı yalnız DİĞER sekmelerde tetiklenir). */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStoredMode(): ViewMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "detayli" || stored === "basit" ? stored : DEFAULT_MODE;
  } catch {
    // Depolama kapalıysa (gizli sekme, site verisi engelli) varsayılan kalır.
    return DEFAULT_MODE;
  }
}

/** Sunucu her zaman varsayılanı render eder; kayıtlı tercih bağlanınca uygulanır. */
function serverSnapshot(): ViewMode {
  return DEFAULT_MODE;
}

function writeStoredMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Yazılamazsa tercih yalnız bu sayfa görüntülemesi boyunca geçerli olur.
  }
  for (const listener of listeners) listener();
}

interface ViewModeValue {
  mode: ViewMode;
  isSimple: boolean;
  toggle: () => void;
  setMode: (mode: ViewMode) => void;
}

const ViewModeContext = createContext<ViewModeValue | null>(null);

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, readStoredMode, serverSnapshot);

  const setMode = useCallback((next: ViewMode) => {
    writeStoredMode(next);
  }, []);

  const value = useMemo<ViewModeValue>(
    () => ({
      mode,
      isSimple: mode === "basit",
      toggle: () => {
        writeStoredMode(mode === "basit" ? "detayli" : "basit");
      },
      setMode,
    }),
    [mode, setMode],
  );

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeValue {
  const context = useContext(ViewModeContext);
  if (!context) {
    throw new Error("useViewMode yalnızca ViewModeProvider içinde kullanılabilir.");
  }
  return context;
}

/**
 * Mod düğmesi — sol altta, küçük ve sabit.
 *
 * Mobilde alt sekme çubuğunun ÜSTÜNDE durur; çubuğu örtmez. Masaüstünde
 * sayfanın sol alt köşesindedir.
 */
export function ViewModeToggle() {
  const { isSimple, toggle } = useViewMode();
  return (
    <button
      type="button"
      onClick={toggle}
      className="view-mode-toggle"
      data-testid="view-mode-toggle"
      data-mode={isSimple ? "basit" : "detayli"}
      aria-label={isSimple ? "Detaylı moda geç" : "Basit moda geç"}
      title={
        isSimple
          ? "Detaylı mod: satış ekleme, gerçekleşmiş kâr/zarar ve kaynak ayrıntıları"
          : "Basit mod: yalnızca altın ekleme, portföy ve kâr/zarar"
      }
    >
      {isSimple ? "Detaylı mod" : "Basit mod"}
    </button>
  );
}
