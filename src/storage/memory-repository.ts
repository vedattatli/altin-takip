import type {
  AccountingSummary,
  LedgerAppendResult,
  LedgerCommand,
  LedgerEntry,
  LedgerReplaceResult,
  LedgerVoidResult,
} from "@/domain/accounting/types";
import type { PortfolioMeta } from "@/domain/types";
import {
  localAppend,
  localReplace,
  localSnapshot,
  localSummary,
  localVoid,
  localVoidAll,
  sortLedgerDesc,
  type LocalLedgerState,
} from "./local-ledger";
import { defaultPortfolio, nowISO, type PortfolioRepository, type RepositoryKind } from "./types";

/**
 * Bellek içi depo. Testler ve sunucu tarafı yardımcıları için.
 * Sayfa yenilenince veriyi KORUMAZ; üretimde kullanılmaz.
 */
export class MemoryPortfolioRepository implements PortfolioRepository {
  readonly kind: RepositoryKind = "memory";
  readonly label = "Geçici bellek";
  readonly syncsAcrossDevices = false;

  private portfolio: PortfolioMeta;
  private state: LocalLedgerState = { entries: [], nextSequence: 1 };

  constructor(portfolio: PortfolioMeta = defaultPortfolio()) {
    this.portfolio = portfolio;
  }

  async getPortfolio(): Promise<PortfolioMeta> {
    return { ...this.portfolio };
  }

  async renamePortfolio(patch: { name?: string; displayName?: string }): Promise<PortfolioMeta> {
    this.portfolio = {
      ...this.portfolio,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      updatedAt: nowISO(),
    };
    return { ...this.portfolio };
  }

  async getSummary(): Promise<AccountingSummary> {
    return localSummary(this.state.entries, await localSnapshot());
  }

  async listLedger(): Promise<LedgerEntry[]> {
    return sortLedgerDesc(this.state.entries);
  }

  private commit(entries: LedgerEntry[]): void {
    this.state = {
      entries,
      nextSequence: entries.reduce((max, entry) => Math.max(max, entry.ledgerSequence), 0) + 1,
    };
  }

  async appendTransaction(command: LedgerCommand): Promise<LedgerAppendResult> {
    const { result, entries } = await localAppend(this.state, this.portfolio.id, command);
    this.commit(entries);
    return result;
  }

  async replaceTransaction(id: string, command: LedgerCommand): Promise<LedgerReplaceResult> {
    const { result, entries } = await localReplace(this.state, this.portfolio.id, id, command);
    this.commit(entries);
    return result;
  }

  async voidTransaction(id: string, reason: string): Promise<LedgerVoidResult> {
    const { result, entries } = localVoid(this.state, id, reason);
    this.commit(entries);
    return result;
  }

  async voidAll(): Promise<number> {
    const { count, entries } = localVoidAll(this.state);
    this.commit(entries);
    return count;
  }
}
