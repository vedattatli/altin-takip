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
import { getPriceProvider, validateUsableQuote, type PriceSnapshot } from "@/prices";
import { devOnlyProviderBlocked } from "@/prices/dev-gate";
import { PriceSourceService, type ActiveSourceView } from "@/server/prices/price-source-service";
import { ownScope, type UserActor } from "@/server/auth/actor";
import {
  IdempotencyConflictError,
  LedgerEntryNotActiveError,
  LedgerEntryNotFoundError,
  OversellError,
  PortfolioNotProvisionedError,
  type AuthBackend,
  type LedgerAppendResult,
  type LedgerRevision,
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PortfolioOverview {
  portfolio: PortfolioMeta;
  summary: AccountingSummary;
}

export class UserPortfolioService {
  private readonly sources: PriceSourceService;

  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {
    this.sources = new PriceSourceService(backend, options);
  }

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

  /**
   * AKTİF KAYNAĞIN anlık görüntüsü (merkezi ingestion'dan; tarayıcı sağlayıcıya bağlanmaz).
   *
   * SESSİZ FALLBACK YOKTUR: seçili kaynak veri vermiyorsa BAŞKA sağlayıcıya geçilmez;
   * boş/bayat anlık görüntü döner ve arayüz "Fiyat verisi kullanılamıyor" gösterir.
   * Tek istisna: HİÇBİR kaynak seçili değilse ve ortam üretim DEĞİLSE, geliştirme
   * kolaylığı için test sağlayıcısı kullanılır (arayüzde "Test Verisi" etiketiyle).
   */
  async activeSource(actor: UserActor): Promise<{ snapshot: PriceSnapshot | null; source: ActiveSourceView }> {
    const active = await this.sources.activeSnapshot(actor);
    if (active.source.status === "not_selected" && !devOnlyProviderBlocked()) {
      const snapshot = await getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
      return {
        snapshot,
        source: {
          providerCode: snapshot.provider.id,
          displayName: snapshot.provider.label,
          technicalName: "MockPriceProvider (geliştirme)",
          marketId: snapshot.provider.market,
          marketDisplayName: "Test Piyasası",
          attribution: snapshot.provider.disclaimer,
          upstreamSourceLabel: null,
          isRealMarketData: false,
          lastQuoteAt: snapshot.fetchedAt,
          status: "ok",
          coverage: Object.keys(snapshot.quotes).length,
          userSelectable: false,
        },
      };
    }
    return active;
  }

  /**
   * Geriye uyumluluk: kaynak seçimi gerektirmeyen yerler için (açılış bakiyesi vb.).
   *
   * ÜRETİMDE TEST VERİSİNE DÜŞMEZ. Aktif kaynak yoksa veya veri vermiyorsa boş bir
   * "unavailable" anlık görüntü döner; MARKET_BASELINE oluşturulmaz ve değerleme
   * hesaplanmış gibi gösterilmez. Test sağlayıcısına yalnızca geliştirme ortamında
   * (ve Playwright'ın kaçış kapısı açıkken) düşülür.
   */
  async currentSnapshot(actor?: UserActor): Promise<PriceSnapshot> {
    if (actor) {
      const active = await this.activeSource(actor);
      if (active.snapshot) return active.snapshot;
    }
    if (devOnlyProviderBlocked()) return this.unavailableSnapshot();
    return getPriceProvider().getQuotes(ALL_PRODUCT_IDS);
  }

  /** Fiyatsız anlık görüntü: hiçbir ürün için quote yoktur ve kaynak "yok" olarak etiketlenir. */
  private unavailableSnapshot(): PriceSnapshot {
    return {
      provider: {
        id: "none",
        label: "Kaynak seçilmedi",
        market: "NONE",
        isRealMarketData: false,
        disclaimer: "Seçili bir fiyat kaynağı yok; güncel değerleme hesaplanmaz.",
        staleAfterMs: 0,
      },
      quotes: {},
      fetchedAt: new Date(this.now()).toISOString(),
      status: "unavailable",
      error: "Seçili bir fiyat kaynağı yok veya kaynak veri vermiyor.",
    };
  }

  /**
   * Özet: türetilmiş pozisyonlar + sunucu tarafı değerleme.
   * Salt okuma; hiçbir şey yazmaz. Fiyat yoksa/bayatsa değerleme alanları null döner.
   */
  async getSummary(actor: UserActor): Promise<AccountingSummary> {
    try {
      const [positions, active, ledger] = await Promise.all([
        this.backend.listPositions(ownScope(actor)),
        this.activeSource(actor),
        this.backend.listLedger(ownScope(actor)),
      ]);
      // Defter kayıt sayısı portföy durumunu (NEVER_USED / CLOSED / OPEN) belirler.
      const summary = valuePositions(positions, active.snapshot, this.now(), {
        ledgerEntryCount: ledger.length,
      });
      return { ...summary, priceSource: active.source };
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** Defter sürümü: cihazlar arası senkronizasyon sinyali. Salt okuma. */
  async getLedgerRevision(actor: UserActor): Promise<LedgerRevision> {
    try {
      return await this.backend.getLedgerRevision(ownScope(actor));
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
    const [ledger, active] = await Promise.all([
      this.backend.listLedger(ownScope(actor)),
      this.activeSource(actor),
    ]);
    return buildAccountingSummary(ledger, active.snapshot, this.now());
  }

  /**
   * MARKET_BASELINE için sunucu fiyatı: istemciden gelen fiyat KABUL EDİLMEZ.
   * Fiyat yoksa, geçersizse, bayatsa, makası tersse veya zamanı gelecekteyse null döner
   * (açılış bakiyesi oluşturulmaz; başka ürün/piyasadan ikame yapılmaz).
   */
  async baselineSnapshotFor(productId: string, actor?: UserActor): Promise<PriceSnapshotInput | null> {
    const snapshot = await this.currentSnapshot(actor);
    // MERKEZİ quote doğrulaması (ürün/sağlayıcı/piyasa/zaman); değerleme ile aynı kurallar.
    const usable = validateUsableQuote(snapshot, snapshot.quotes[productId], productId, this.now());
    if (!usable.ok) return null;
    const quote = usable.quote;
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
      staleAfterMs: snapshot.provider.staleAfterMs,
    };
    return validatePriceSnapshotInput(input, productId, this.now()) === null ? input : null;
  }

  /** Kimlik biçimi geçersizse kayıt "yok" sayılır (404); veritabanına kontrolsüz cast gitmez. */
  private assertEntryId(entryId: string): void {
    if (!UUID_PATTERN.test(entryId)) throw notFound("İşlem bulunamadı.");
  }

  /**
   * İstemciden gelen gövdeyi SUNUCUDA sıkı biçimde doğrular ve arka uç isteğine çevirir.
   * İstemci doğrulaması yalnızca kullanıcı deneyimi içindir.
   */
  private async parseCommand(raw: unknown, actor?: UserActor): Promise<LedgerAppendRequest> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw badRequest("Geçersiz işlem verisi.");
    }
    const body = raw as Record<string, unknown>;
    let baselineSnapshot: PriceSnapshotInput | null = null;
    if (body.kind === "OPENING_BALANCE" && body.costMethod === "MARKET_BASELINE") {
      const productId = typeof body.productId === "string" ? body.productId : "";
      baselineSnapshot = productId ? await this.baselineSnapshotFor(productId, actor) : null;
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
    const request = await this.parseCommand(raw, actor);
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
    this.assertEntryId(entryId);
    try {
      return await this.backend.voidLedgerEntry(ownScope(actor), entryId, reason);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /** "Düzenle": eski kayıt REPLACED olur, yerine yeni kayıt eklenir; tek işlem. */
  async replaceTransaction(actor: UserActor, entryId: string, raw: unknown): Promise<LedgerReplaceResult> {
    this.assertEntryId(entryId);
    const request = await this.parseCommand(raw, actor);
    try {
      return await this.backend.replaceLedgerEntry(ownScope(actor), entryId, request);
    } catch (error) {
      this.toAppError(error);
    }
  }

  /**
   * Hesap/veri silme talebi.
   * Silme işlemini yönetici yapar; bu metot talebi denetim kaydına yazar ve
   * kullanıcıya sürecin ne olduğunu bildirir. Veri BURADA silinmez.
   */
  async requestAccountDeletion(actor: UserActor, rawReason: unknown): Promise<{
    requested: boolean;
    receivedAt: string;
    message: string;
  }> {
    const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 500) : "";
    const receivedAt = new Date(this.now()).toISOString();
    try {
      await this.backend.appendAudit({
        adminUserId: actor.profile.id,
        adminUsername: actor.profile.username,
        targetUserId: actor.profile.id,
        targetUsername: actor.profile.username,
        action: "data.deletion_request",
        success: true,
        // Denetim kaydına finansal içerik veya hassas veri yazılmaz.
        metadata: { hasReason: reason.length > 0 },
      });
    } catch {
      // Talep kaydı yazılamazsa kullanıcıya yine de süreç bildirilir; sunucuya loglanır.
      console.error("ALTIN_DELETION_REQUEST_AUDIT_FAILURE", { userId: actor.profile.id });
    }
    return {
      requested: true,
      receivedAt,
      message:
        "Silme talebiniz alındı. Hesabınız ve uygulamaya kaydettiğiniz portföy verisi yönetici onayıyla " +
        "kalıcı olarak silinir. Silmeden önce verilerinizi CSV olarak dışa aktarabilirsiniz.",
    };
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
