import "server-only";

import {
  buildAccountingSummary,
  parseLedgerCommand,
  validatePriceSnapshotInput,
  valuePositions,
  type AccountingSummary,
  type LedgerAppendRequest,
  type LedgerEntry,
  type PriceSnapshotInput,
  type ProductPosition,
} from "@/domain/accounting";
import { LedgerAmountError } from "@/domain/accounting/amounts";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { PortfolioMeta } from "@/domain/types";
import { getPriceProvider, isSnapshotStale, type PriceSnapshot } from "@/prices";
import { ownScope, type UserActor } from "@/server/auth/actor";
import {
  IdempotencyConflictError,
  LedgerEntryNotActiveError,
  LedgerEntryNotFoundError,
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
  type LedgerAppendResult,
  type LedgerReplaceResult,
  type LedgerVoidResult,
} from "@/server/auth/backend";
import {
  badRequest,
  conflict,
  idempotencyConflict,
  notFound,
  oversell,
  portfolioNotProvisioned,
  priceUnavailable,
} from "@/server/auth/errors";

/**
 * Kullanıcının KENDİ portföyü.
 *
 * Bu servisin hiçbir metodu hedef kullanıcı kimliği ALMAZ. Erişilen satırlar
 * her zaman `ownScope(actor)` ile belirlenir; dolayısıyla bir route gövdeden
 * gelen bir kimlikle başka kullanıcının verisine ulaşamaz.
 *
 * Başka kullanıcıyı hedefleyen işlemler AdminService'tedir (salt okunur).
 *
 * MUHASEBE: işlem defteri kaynak gerçektir; pozisyonlar türetilir. Bütün
 * finansal mutation'lar arka ucun atomik yoluna (Postgres RPC / yerel kuyruk)
 * gider; bu katman doğrulama, fiyat anlık görüntüsü ve hata dönüşümü yapar.
 */

const ALL_PRODUCT_IDS = GOLD_PRODUCTS.map((product) => product.id);
const VOID_REASON_MAX = 140;

export interface PortfolioOverview {
  portfolio: PortfolioMeta;
  summary: AccountingSummary;
}

export class UserPortfolioService {
  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Salt okuma: hiçbir koşulda veritabanını değiştirmez. */
  async getPortfolio(actor: UserActor): Promise<PortfolioMeta> {
    try {
      return await this.backend.getPortfolio(ownScope(actor));
    } catch (error) {
      this.toAppError(error);
    }
  }

  async renamePortfolio(
    actor: UserActor,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta> {
    const clean = {
      ...(typeof patch.name === "string" ? { name: patch.name.trim().slice(0, 80) } : {}),
      ...(typeof patch.displayName === "string"
        ? { displayName: patch.displayName.trim().slice(0, 80) }
        : {}),
    };
    if (clean.name !== undefined && clean.name.length === 0) {
      throw badRequest("Portföy adı boş olamaz.");
    }
    try {
      return await this.backend.updatePortfolio(ownScope(actor), clean);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** Sunucunun fiyat sağlayıcısından anlık görüntü. Test verisi olduğu snapshot'ta etiketlidir. */
  async currentSnapshot(): Promise<PriceSnapshot> {
    return getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
  }

  /**
   * Özet: türetilmiş pozisyonlar + sunucu tarafı değerleme.
   * Salt okuma; hiçbir şey yazmaz. Fiyat yoksa/bayatsa değerleme alanları null döner.
   */
  async getSummary(actor: UserActor): Promise<AccountingSummary> {
    try {
      const [positions, snapshot] = await Promise.all([
        this.backend.listPositions(ownScope(actor)),
        this.currentSnapshot(),
      ]);
      return valuePositions(positions, snapshot, this.now());
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** Defter kayıtları (ACTIVE, VOID, REPLACED). VOID/REPLACED kullanıcıdan gizlenmez. */
  async listLedger(actor: UserActor): Promise<LedgerEntry[]> {
    return this.backend.listLedger(ownScope(actor));
  }

  async listPositions(actor: UserActor): Promise<ProductPosition[]> {
    return this.backend.listPositions(ownScope(actor));
  }

  /** Defterden bağımsız çapraz doğrulama (accounting:verify). */
  async recomputeSummary(actor: UserActor): Promise<AccountingSummary> {
    const [ledger, snapshot] = await Promise.all([
      this.backend.listLedger(ownScope(actor)),
      this.currentSnapshot(),
    ]);
    return buildAccountingSummary(ledger, snapshot, this.now());
  }

  /**
   * MARKET_BASELINE için sunucu fiyatı: istemciden gelen fiyat KABUL EDİLMEZ.
   * Fiyat yoksa, geçersizse, bayatsa, makası tersse veya zamanı gelecekteyse null döner
   * (açılış bakiyesi oluşturulmaz; başka ürün/piyasadan ikame yapılmaz).
   */
  async baselineSnapshotFor(productId: string): Promise<PriceSnapshotInput | null> {
    const snapshot = await this.currentSnapshot();
    if (snapshot.status === "unavailable" || isSnapshotStale(snapshot, this.now())) return null;
    const quote = snapshot.quotes[productId];
    if (!quote || quote.status !== "ok") return null;
    const input: PriceSnapshotInput = {
      productId,
      liquidationPrice: quote.liquidationPrice,
      replacementPrice: quote.replacementPrice,
      provider: quote.provider,
      market: quote.market,
      currency: quote.currency,
      providerStatus: quote.status,
      isRealMarketData: snapshot.provider.isRealMarketData,
      providerTimestamp: quote.providerTimestamp,
      fetchedAt: quote.fetchedAt,
    };
    return validatePriceSnapshotInput(input, productId, this.now()) === null ? input : null;
  }

  /**
   * İstemciden gelen gövdeyi SUNUCUDA sıkı biçimde doğrular ve arka uç isteğine çevirir.
   * İstemci doğrulaması yalnızca kullanıcı deneyimi içindir.
   */
  private async parseCommand(raw: unknown): Promise<LedgerAppendRequest> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw badRequest("Geçersiz işlem verisi.");
    }
    const body = raw as Record<string, unknown>;
    let baselineSnapshot: PriceSnapshotInput | null = null;
    if (body.kind === "OPENING_BALANCE" && body.costMethod === "MARKET_BASELINE") {
      const productId = typeof body.productId === "string" ? body.productId : "";
      baselineSnapshot = productId ? await this.baselineSnapshotFor(productId) : null;
      if (!baselineSnapshot) throw priceUnavailable();
    }

    const parsed = parseLedgerCommand(body, { baselineSnapshot, now: new Date(this.now()) });
    if (!parsed.ok) {
      const firstError = Object.values(parsed.errors).find(Boolean);
      throw badRequest(firstError ?? "İşlem verisi geçersiz.");
    }
    return parsed.request;
  }

  /** Arka uç hatalarını HTTP hatalarına çevirir; iç detay sızdırmaz. */
  private toAppError(error: unknown): never {
    if (error instanceof OversellError) throw oversell(error.available);
    if (error instanceof IdempotencyConflictError) throw idempotencyConflict();
    if (error instanceof LedgerEntryNotFoundError) throw notFound("İşlem bulunamadı.");
    if (error instanceof LedgerEntryNotActiveError) throw conflict(error.message);
    if (error instanceof LedgerAmountError) throw badRequest(error.message);
    if (error instanceof PortfolioNotProvisionedError) throw portfolioNotProvisioned();
    if (error instanceof Error && /İşlem bulunamadı/.test(error.message)) {
      throw notFound("İşlem bulunamadı.");
    }
    throw error;
  }

  /** OPENING_BALANCE / BUY / SELL ekler. İdempotency anahtarı gövdeden (`clientRequestId`) gelir. */
  async appendTransaction(actor: UserActor, raw: unknown): Promise<LedgerAppendResult> {
    const request = await this.parseCommand(raw);
    try {
      return await this.backend.appendLedgerEntry(ownScope(actor), request);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** "Sil": kayıt VOID olur, sebep ve tarih kaydedilir, pozisyon yeniden hesaplanır. */
  async voidTransaction(actor: UserActor, entryId: string, rawReason: unknown): Promise<LedgerVoidResult> {
    const reason =
      typeof rawReason === "string" && rawReason.trim() !== ""
        ? rawReason.trim().slice(0, VOID_REASON_MAX)
        : "Kullanıcı iptal etti";
    try {
      return await this.backend.voidLedgerEntry(ownScope(actor), entryId, reason);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** "Düzenle": eski kayıt REPLACED olur, yerine yeni kayıt eklenir; tek işlem. */
  async replaceTransaction(actor: UserActor, entryId: string, raw: unknown): Promise<LedgerReplaceResult> {
    const request = await this.parseCommand(raw);
    try {
      return await this.backend.replaceLedgerEntry(ownScope(actor), entryId, request);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** Tüm aktif kayıtları iptal eder (hard delete yok). */
  async voidAllTransactions(actor: UserActor): Promise<number> {
    try {
      return await this.backend.voidAllLedgerEntries(ownScope(actor), "Kullanıcı tüm işlemleri iptal etti");
    } catch (error) {
      this.toAppError(error);
    }
  }
}
