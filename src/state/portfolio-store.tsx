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

import { GOLD_PRODUCTS } from "@/domain/catalog";
import { buildPortfolio, EMPTY_SUMMARY, type PortfolioSummary } from "@/domain/portfolio";
import type { PortfolioMeta, Transaction, TransactionInput } from "@/domain/types";
import { getPriceProvider, type PriceSnapshot } from "@/prices";
import { createRepository, type PortfolioRepository, type StorageMode } from "@/storage";

/**
 * Portföy durumu.
 *
 * Depolama katmanı arayüzden soyutlanmıştır: aynı bileşenler hem hesap
 * (sunucu) hem de demo (IndexedDB) modunda çalışır.
 */

interface PortfolioContextValue {
  mode: StorageMode;
  repository: PortfolioRepository;
  portfolio: PortfolioMeta | null;
  transactions: Transaction[];
  summary: PortfolioSummary;
  snapshot: PriceSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  isOnline: boolean;
  refreshPrices: () => Promise<void>;
  addTransaction: (input: TransactionInput) => Promise<Transaction>;
  editTransaction: (id: string, input: TransactionInput) => Promise<Transaction>;
  removeTransaction: (id: string) => Promise<void>;
  renamePortfolio: (patch: { name?: string; displayName?: string }) => Promise<void>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

const PRICE_REFRESH_MS = 60_000;
const ALL_PRODUCT_IDS = GOLD_PRODUCTS.map((product) => product.id);

export function PortfolioProvider({
  mode,
  children,
}: {
  mode: StorageMode;
  children: ReactNode;
}) {
  const repository = useMemo(() => createRepository(mode), [mode]);
  const [portfolio, setPortfolio] = useState<PortfolioMeta | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
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

  const refreshPrices = useCallback(async () => {
    const next = await getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
    if (mounted.current) setSnapshot(next);
  }, []);

  // İlk yükleme: portföy + işlemler + fiyatlar.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const [meta, rows] = await Promise.all([
          repository.getPortfolio(),
          repository.listTransactions(),
        ]);
        if (cancelled) return;
        setPortfolio(meta);
        setTransactions(rows);
        await refreshPrices();
        if (!cancelled) {
          setError(null);
          setStatus("ready");
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Veriler yüklenemedi.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, refreshPrices]);

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

  const addTransaction = useCallback(
    async (input: TransactionInput) => {
      const created = await repository.createTransaction(input);
      setTransactions((current) => [...current, created]);
      return created;
    },
    [repository],
  );

  const editTransaction = useCallback(
    async (id: string, input: TransactionInput) => {
      const updated = await repository.updateTransaction(id, input);
      setTransactions((current) => current.map((tx) => (tx.id === id ? updated : tx)));
      return updated;
    },
    [repository],
  );

  const removeTransaction = useCallback(
    async (id: string) => {
      await repository.deleteTransaction(id);
      setTransactions((current) => current.filter((tx) => tx.id !== id));
    },
    [repository],
  );

  const renamePortfolio = useCallback(
    async (patch: { name?: string; displayName?: string }) => {
      const updated = await repository.renamePortfolio(patch);
      setPortfolio(updated);
    },
    [repository],
  );

  const summary = useMemo(
    () => (transactions.length === 0 ? EMPTY_SUMMARY : buildPortfolio(transactions, snapshot)),
    [transactions, snapshot],
  );

  const value = useMemo<PortfolioContextValue>(
    () => ({
      mode,
      repository,
      portfolio,
      transactions,
      summary,
      snapshot,
      status,
      error,
      isOnline,
      refreshPrices,
      addTransaction,
      editTransaction,
      removeTransaction,
      renamePortfolio,
    }),
    [
      mode,
      repository,
      portfolio,
      transactions,
      summary,
      snapshot,
      status,
      error,
      isOnline,
      refreshPrices,
      addTransaction,
      editTransaction,
      removeTransaction,
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
