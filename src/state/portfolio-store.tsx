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
  refresh: () => Promise<void>;
  refreshPrices: () => Promise<void>;
  appendTransaction: (command: LedgerCommand) => Promise<LedgerAppendResult>;
  replaceTransaction: (id: string, command: LedgerCommand) => Promise<LedgerReplaceResult>;
  voidTransaction: (id: string, reason: string) => Promise<LedgerVoidResult>;
  renamePortfolio: (patch: { name?: string; displayName?: string }) => Promise<void>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

const PRICE_REFRESH_MS = 60_000;

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
  const [isOnline, setIsOnline] = useState(true);
  const mounted = useRef(true);

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

  /** Defter + özet birlikte yenilenir (her mutation sonrası). */
  const refresh = useCallback(async () => {
    const [rows, next] = await Promise.all([repository.listLedger(), repository.getSummary()]);
    if (!mounted.current) return;
    setLedger(rows);
    setSummary(next);
  }, [repository]);

  // İlk yükleme: portföy + defter + özet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const [meta, rows, next] = await Promise.all([
          repository.getPortfolio(),
          repository.listLedger(),
          repository.getSummary(),
        ]);
        if (cancelled) return;
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
  }, [repository]);

  // Fiyatları düzenli tazele.
  useEffect(() => {
    const timer = setInterval(() => void refreshPrices(), PRICE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshPrices]);

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

  const appendTransaction = useCallback(
    async (command: LedgerCommand) => {
      const result = await repository.appendTransaction(command);
      await refresh();
      return result;
    },
    [repository, refresh],
  );

  const replaceTransaction = useCallback(
    async (id: string, command: LedgerCommand) => {
      const result = await repository.replaceTransaction(id, command);
      await refresh();
      return result;
    },
    [repository, refresh],
  );

  const voidTransaction = useCallback(
    async (id: string, reason: string) => {
      const result = await repository.voidTransaction(id, reason);
      await refresh();
      return result;
    },
    [repository, refresh],
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
