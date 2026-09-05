"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  EMPTY_SUMMARY,
  type AccountingSummary,
  type LedgerAppendResult,
  type LedgerCommand,
  type LedgerEntry,
  type LedgerReplaceResult,
  type LedgerVoidResult,
} from "@/domain/accounting";
import type { PortfolioMeta } from "@/domain/types";
import type { PriceSnapshot } from "@/prices/types";
import { createRepository, type PortfolioRepository, type StorageMode } from "@/storage";

/**
 * Portföy durumu.
 *
 * Depolama katmanı arayüzden soyutlanmıştır: aynı bileşenler hem hesap
 * (sunucu) hem de demo (IndexedDB) modunda çalışır. Özet (pozisyon +
 * değerleme) depodan gelir; hesap modunda SUNUCU hesaplar. Her mutation
 * sonrasında defter ve özet yeniden okunur; istemci kendi başına toplam
 * hesaplamaz.
 */

export type SyncStatus = "off" | "idle" | "syncing" | "paused" | "error";

interface PortfolioContextValue {
  mode: StorageMode;
  repository: PortfolioRepository;
  portfolio: PortfolioMeta | null;
  ledger: LedgerEntry[];
  summary: AccountingSummary;
  snapshot: PriceSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  isOnline: boolean;
  /** Cihazlar arası senkronizasyon: son başarılı sürüm kontrolü (ms) ve durum. */
  lastSyncedAt: number | null;
  syncStatus: SyncStatus;
  refresh: () => Promise<void>;
  refreshPrices: () => Promise<void>;
  appendTransaction: (command: LedgerCommand) => Promise<LedgerAppendResult>;
  replaceTransaction: (id: string, command: LedgerCommand) => Promise<LedgerReplaceResult>;
  voidTransaction: (id: string, reason: string) => Promise<LedgerVoidResult>;
  renamePortfolio: (patch: { name?: string; displayName?: string }) => Promise<void>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

const PRICE_REFRESH_MS = 60_000;
/** Sürüm kontrolü aralığı (sayfa görünür + çevrimiçi). */
const SYNC_INTERVAL_MS = 9_000;
/** Geçici hatalarda üstel geri çekilme üst sınırı. */
const SYNC_MAX_BACKOFF_MS = 60_000;
const SYNC_JITTER_MS = 1_500;

export function PortfolioProvider({
  mode,
  children,
}: {
  mode: StorageMode;
  children: ReactNode;
}) {
  const repository = useMemo(() => createRepository(mode), [mode]);
  const [portfolio, setPortfolio] = useState<PortfolioMeta | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<AccountingSummary>(EMPTY_SUMMARY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  /** İlk yükleme sayacı; artınca yükleme efekti yeniden çalışır (hata sonrası kurtarma). */
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(repository.getVersion ? "idle" : "off");
  const mounted = useRef(true);
  /** Bilinen son defter sürümü; değişince defter + özet yeniden okunur. */
  const versionRef = useRef<{ revision: number | null; etag: string | null }>({ revision: null, etag: null });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Değerleme yenilemesi: fiyat + pozisyon özeti depodan yeniden okunur. */
  const refreshPrices = useCallback(async () => {
    try {
      const next = await repository.getSummary();
      if (mounted.current) setSummary(next);
    } catch {
      // Fiyat/özet yenilenemezse mevcut özet korunur; kullanıcı "Yenile" ile tekrar deneyebilir.
    }
  }, [repository]);

  /**
   * Bilinen sürüm temeli, defter okunmadan ÖNCE örneklenir.
   *
   * Sürüm veriden sonra okunursa iki istek arasında başka cihazdan gelen yazma,
   * elde eski defter varken "bilinen sürüm" olarak kaydedilir; sonraki her kontrol
   * 304 alacağı için o değişiklik bir daha yüklenmez. Önce örneklemek en kötü
   * ihtimalle bir kez fazladan yenileme yapar, değişiklik kaçırmaz.
   */
  const sampleVersion = useCallback(async () => {
    if (!repository.getVersion) return null;
    try {
      const version = await repository.getVersion(null);
      if (version.notModified) return null;
      return { revision: version.revision, etag: version.etag };
    } catch {
      // Sürüm okunamazsa bir sonraki kontrol dener.
      return null;
    }
  }, [repository]);

  /** Defter + özet + portföy meta birlikte yenilenir (her mutation ve uzak değişiklik sonrası). */
  const refresh = useCallback(async () => {
    const pending = await sampleVersion();
    const [rows, next, meta] = await Promise.all([
      repository.listLedger(),
      repository.getSummary(),
      repository.getPortfolio().catch(() => null),
    ]);
    if (!mounted.current) return;
    setLedger(rows);
    setSummary(next);
    if (meta) setPortfolio(meta);
    // Kendi mutation'ımızdan sonra bilinen sürüm güncellenir; poller aynı değişikliği ikinci kez yüklemez.
    if (pending) {
      versionRef.current = pending;
      setLastSyncedAt(Date.now());
    }
  }, [repository, sampleVersion]);

  // İlk yükleme: portföy + defter + özet. loadAttempt artınca yeniden denenir.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        // Sürüm veriden önce örneklenir; böylece poller'ın ilk kontrolünde temel
        // zaten doludur ve aradaki uzak değişiklik "bilinen" sanılıp atlanmaz.
        const pending = await sampleVersion();
        const [meta, rows, next] = await Promise.all([
          repository.getPortfolio(),
          repository.listLedger(),
          repository.getSummary(),
        ]);
        if (cancelled) return;
        if (pending) versionRef.current = pending;
        setPortfolio(meta);
        setLedger(rows);
        setSummary(next);
        setError(null);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Veriler yüklenemedi.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, sampleVersion, loadAttempt]);

  /**
   * Hata ekranından çıkış yolu.
   *
   * İlk yükleme başarısız olursa senkronizasyon poller'ı hiç kurulmaz (status
   * "ready" değil), yani uygulama kendi başına toparlanamaz. Bağlantı geri
   * geldiğinde ya da sekmeye dönüldüğünde yükleme yeniden denenir.
   */
  useEffect(() => {
    if (status !== "error") return;
    const retry = () => setLoadAttempt((n) => n + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status]);

  // Fiyatları düzenli tazele.
  useEffect(() => {
    const timer = setInterval(() => void refreshPrices(), PRICE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshPrices]);

  /**
   * Cihazlar arası senkronizasyon: revision polling.
   * - Sayfa görünür ve çevrimiçiyken ~9 sn'de bir hafif sürüm kontrolü (ETag/304).
   * - Sekme arka plandayken durur; visibilitychange / focus / online'da hemen kontrol eder.
   * - Aynı anda tek istek (AbortController); geçici hatada üstel geri çekilme + jitter.
   * - Sürüm değiştiyse defter + özet + portföy meta yeniden yüklenir.
   */
  useEffect(() => {
    const getVersion = repository.getVersion?.bind(repository);
    if (!getVersion || status !== "ready") return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), delay);
    };
    const nextDelay = () => {
      const base = failures === 0 ? SYNC_INTERVAL_MS : Math.min(SYNC_MAX_BACKOFF_MS, SYNC_INTERVAL_MS * 2 ** failures);
      return base + Math.floor(Math.random() * SYNC_JITTER_MS);
    };

    const check = async () => {
      if (disposed) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        setSyncStatus("paused");
        return; // görünür olunca visibilitychange yeniden başlatır
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setSyncStatus("paused");
        return; // online olayı yeniden başlatır
      }
      if (controller) return; // üst üste istek yok
      controller = new AbortController();
      setSyncStatus("syncing");
      try {
        const result = await getVersion(versionRef.current.etag, controller.signal);
        if (disposed) return;
        if (!result.notModified) {
          const known = versionRef.current.revision;
          // Sürüm işaretçisi yalnızca yenileme başarıyla bittikten SONRA ilerler:
          // refresh() hata fırlatırsa versionRef eski etag'de kalır, bir sonraki
          // kontrol 304 yerine 200 alır ve kaçırılan değişikliği yeniden dener.
          if (known !== null && known !== result.revision) await refresh();
          versionRef.current = { revision: result.revision, etag: result.etag };
        }
        failures = 0;
        setLastSyncedAt(Date.now());
        setSyncStatus("idle");
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        failures += 1;
        setSyncStatus("error");
      } finally {
        controller = null;
      }
      if (!disposed) schedule(nextDelay());
    };

    const wake = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      void check();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
      else if (timer) clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    void check();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [repository, status, refresh]);

  // Bağlantı durumu — kullanıcıya açıkça bildirilir.
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  /**
   * Yazma başarılı olduktan sonraki geri-okuma hatası çağırana YANSITILMAZ.
   *
   * Aksi hâlde sunucuya işlenmiş bir işlem forma "kaydedilemedi" diye döner;
   * kullanıcı formu kapatıp yeniden denediğinde yeni clientRequestId üretildiği
   * için aynı kayıt ikinci kez oluşur. Liste bir sonraki poller turunda dolar.
   */
  const refreshAfterWrite = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // Durum yalnızca senkronizasyon açıkken anlamlı; demo modunda "off" kalır,
      // yoksa cihazlar arası aktarım uyarısı yanlış yere düşer.
      if (repository.getVersion) setSyncStatus("error");
    }
  }, [refresh, repository]);

  const appendTransaction = useCallback(
    async (command: LedgerCommand) => {
      const result = await repository.appendTransaction(command);
      await refreshAfterWrite();
      return result;
    },
    [repository, refreshAfterWrite],
  );

  const replaceTransaction = useCallback(
    async (id: string, command: LedgerCommand) => {
      const result = await repository.replaceTransaction(id, command);
      await refreshAfterWrite();
      return result;
    },
    [repository, refreshAfterWrite],
  );

  const voidTransaction = useCallback(
    async (id: string, reason: string) => {
      const result = await repository.voidTransaction(id, reason);
      await refreshAfterWrite();
      return result;
    },
    [repository, refreshAfterWrite],
  );

  const renamePortfolio = useCallback(
    async (patch: { name?: string; displayName?: string }) => {
      const updated = await repository.renamePortfolio(patch);
      setPortfolio(updated);
    },
    [repository],
  );

  const value = useMemo<PortfolioContextValue>(
    () => ({
      mode,
      repository,
      portfolio,
      ledger,
      summary,
      snapshot: summary.snapshot,
      status,
      error,
      isOnline,
      lastSyncedAt,
      syncStatus,
      refresh,
      refreshPrices,
      appendTransaction,
      replaceTransaction,
      voidTransaction,
      renamePortfolio,
    }),
    [
      mode,
      repository,
      portfolio,
      ledger,
      summary,
      status,
      error,
      isOnline,
      lastSyncedAt,
      syncStatus,
      refresh,
      refreshPrices,
      appendTransaction,
      replaceTransaction,
      voidTransaction,
      renamePortfolio,
    ],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio(): PortfolioContextValue {
  const context = useContext(PortfolioContext);
  if (!context) {
    throw new Error("usePortfolio yalnızca PortfolioProvider içinde kullanılabilir.");
  }
  return context;
}
