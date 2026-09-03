import { numberFromEnv } from "@/lib/env";
import "server-only";

import { MOCK_PROVIDER_META } from "@/prices/mock-provider";
import { describeProvider, listProviderStatuses } from "@/prices/registry";
import type { PriceQuote, PriceSnapshot } from "@/prices/types";
import { adminScope, ownScope, type AdminActor, type DataScope, type UserActor } from "@/server/auth/actor";
import type { AuthBackend } from "@/server/auth/backend";
import { badRequest, conflict, notFound } from "@/server/auth/errors";
import { PriceIngestionService } from "./ingestion-service";
import { ProviderNotSelectableError, type PriceSourceEventRow, type ProviderQuotesRow } from "./types";

/**
 * AKTİF FİYAT KAYNAĞI
 *
 * Bir portföyde TEK aktif sağlayıcı/piyasa kullanılır. Kurallar:
 *  - Aktif kaynak başarısızsa BAŞKA sağlayıcıya sessizce geçilmez.
 *  - Son geçerli fiyat varsa zamanıyla birlikte "bayat" olarak bildirilir;
 *    değerleme yine de hesaplanmış gibi gösterilmez (Sprint 1.1 kuralı korunur).
 *  - Kullanıcı yalnızca yöneticinin izin verdiği kaynakları seçebilir.
 *  - Her kaynak değişimi denetim olayı üretir.
 */

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

/**
 * Deneysel ekran kaynağı.
 *
 * Bu kaynak genel "kullanıcıya açık" listesine GİREMEZ (veritabanı kısıtı da
 * engeller). Erişim yalnızca yöneticinin portföy bazlı izin listesiyle verilir;
 * kontrol her okumada sunucuda yapılır.
 */
const EXPERIMENTAL_SCREEN_CODE = "sarraf-tv-kayseri-screen";

function staleAfterMs(): number {
  return numberFromEnv("PRICE_STALE_AFTER_MS", DEFAULT_STALE_AFTER_MS, { min: 1 });
}

export interface ActiveSourceView {
  providerCode: string | null;
  displayName: string;
  technicalName: string;
  marketId: string | null;
  marketDisplayName: string;
  attribution: string;
  /** Sağlayıcının kendi üst kaynağı (biliniyorsa). Bilinmiyorsa "Çoklu Kaynak". */
  upstreamSourceLabel: string | null;
  isRealMarketData: boolean;
  lastQuoteAt: string | null;
  status: "ok" | "stale" | "unavailable" | "not_selected";
  coverage: number;
  /** Kullanıcı bu kaynağı değiştirebilir mi? */
  userSelectable: boolean;
}

export interface SourceOptionView {
  providerCode: string;
  displayName: string;
  technicalName: string;
  marketId: string;
  marketDisplayName: string;
  attribution: string;
  coverage: number;
  health: string | null;
  lastSuccessAt: string | null;
  active: boolean;
}

export interface ActiveSnapshotResult {
  snapshot: PriceSnapshot | null;
  source: ActiveSourceView;
}

export class PriceSourceService {
  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Katalog en az bir kez eşitlenmiş olmalıdır.
   *
   * Aksi hâlde hiç yönetim sayfası açılmamış yeni bir kurulumda sağlayıcı satırı
   * bulunmaz ve kullanıcı ekranı boş kalır. Eşitleme idempotenttir ve süreç
   * başına bir kez çalışır.
   */
  private async ensureCatalog(): Promise<void> {
    await new PriceIngestionService(this.backend, this.options).ensureCatalog();
  }

  /** Yöneticinin kullanıcılara açtığı kaynaklar (lisanslı + etkin + seçilebilir). */
  async listSelectableSources(actor: UserActor): Promise<SourceOptionView[]> {
    await this.ensureCatalog();
    const [providers, preference] = await Promise.all([
      this.backend.listPriceProviders(),
      this.backend.getPricePreference(ownScope(actor)),
    ]);
    // Deneysel kaynak yalnızca izin listesindeki kullanıcıya görünür.
    const experimentalAllowed = await this.backend
      .experimentalAccessAllowed(actor.profile.id, EXPERIMENTAL_SCREEN_CODE)
      .catch(() => false);

    return providers
      .filter((provider) => {
        if (!provider.enabled) return false;
        if (provider.licenseStatus === "EXPERIMENTAL_PRIVATE") {
          return provider.code === EXPERIMENTAL_SCREEN_CODE && experimentalAllowed;
        }
        return provider.userSelectable;
      })
      .filter((provider) => !provider.capabilities.includes("REFERENCE_ONLY"))
      .map((provider) => ({
        providerCode: provider.code,
        displayName: provider.displayName,
        technicalName: provider.technicalName,
        marketId: provider.marketId,
        marketDisplayName: provider.marketDisplayName,
        attribution: provider.attribution,
        coverage: provider.coverage,
        health: provider.health?.status ?? null,
        lastSuccessAt: provider.health?.lastSuccessAt ?? null,
        active: provider.code === preference.providerCode,
      }));
  }

  /** Portföyün aktif kaynağı; seçim yoksa AÇIK global varsayılan kullanılır. */
  async resolveActiveProviderCode(actor: UserActor): Promise<string | null> {
    return this.resolveProviderCodeForScope(ownScope(actor));
  }

  /**
   * Bir kapsam için aktif sağlayıcı kodu.
   *
   * Sıra: (1) kullanıcının kendi tercihi, (2) yöneticinin AÇIKÇA seçtiği global
   * varsayılan. "Listedeki ilk açık kaynak" davranışı KULLANILMAZ: bu, sağlayıcı
   * eklendiğinde veya sıralama değiştiğinde kullanıcıların fiyat kaynağını
   * sessizce değiştirirdi. Varsayılan tanımlı değilse kaynak YOKTUR.
   */
  private async resolveProviderCodeForScope(scope: DataScope): Promise<string | null> {
    await this.ensureCatalog();
    const preference = await this.backend.getPricePreference(scope);
    if (preference.providerCode) {
      if (preference.providerCode !== EXPERIMENTAL_SCREEN_CODE) return preference.providerCode;
      // İzin geri alındıysa deneysel kaynak kullanılmaz. BAŞKA KAYNAĞA DA
      // GEÇİLMEZ: kaynak yok sayılır ve değerleme boş kalır.
      const allowed = await this.backend
        .experimentalAccessAllowed(scope.userId, EXPERIMENTAL_SCREEN_CODE)
        .catch(() => false);
      return allowed ? preference.providerCode : null;
    }

    const explicitDefault = await this.backend.defaultPriceProvider();
    if (!explicitDefault) return null;
    const providers = await this.backend.listPriceProviders();
    const row = providers.find((provider) => provider.code === explicitDefault);
    if (!row || !row.enabled || !row.userSelectable) return null;
    if (row.capabilities.includes("REFERENCE_ONLY")) return null;
    return row.code;
  }

  private toSnapshot(row: ProviderQuotesRow, now: number): { snapshot: PriceSnapshot; lastQuoteAt: string | null } {
    const quotes: Record<string, PriceQuote> = {};
    let newest: number | null = null;
    for (const quote of row.quotes) {
      quotes[quote.canonicalProductId] = {
        productId: quote.canonicalProductId,
        liquidationPrice: quote.liquidationPrice,
        replacementPrice: quote.replacementPrice,
        currency: "TRY",
        market: row.marketId,
        provider: row.providerCode,
        providerTimestamp: quote.providerTimestamp,
        fetchedAt: quote.fetchedAt,
        status: quote.status === "ok" ? "ok" : "stale",
      };
      const parsed = Date.parse(quote.fetchedAt);
      if (Number.isFinite(parsed)) newest = newest === null ? parsed : Math.max(newest, parsed);
    }
    const fetchedAt = newest === null ? new Date(now).toISOString() : new Date(newest).toISOString();
    const isReal = row.licenseStatus === "LICENSED";
    return {
      lastQuoteAt: newest === null ? null : new Date(newest).toISOString(),
      snapshot: {
        provider: {
          id: row.providerCode,
          label: row.displayName,
          market: row.marketId,
          isRealMarketData: isReal,
          disclaimer: isReal ? row.attribution : MOCK_PROVIDER_META.disclaimer,
          staleAfterMs: staleAfterMs(),
        },
        quotes,
        fetchedAt,
        status: row.quotes.length === 0 ? "unavailable" : "ok",
        error:
          row.quotes.length === 0
            ? "Aktif fiyat kaynağından kullanılabilir fiyat alınamadı. Başka bir kaynağın fiyatı gösterilmez."
            : null,
      },
    };
  }

  /**
   * Değerleme için aktif kaynağın anlık görüntüsü.
   * SESSİZ FALLBACK YOKTUR: aktif kaynak veri vermiyorsa başka kaynağa geçilmez.
   */
  async activeSnapshot(actor: UserActor): Promise<ActiveSnapshotResult> {
    return this.snapshotForScope(ownScope(actor));
  }

  /**
   * Yöneticinin başka bir kullanıcının portföyünü görüntülerken kullandığı
   * anlık görüntü.
   *
   * HEDEF KULLANICININ aktif kaynağı kullanılır; yöneticinin kendi tercihi veya
   * eski test sağlayıcısı DEĞİL. Yalnızca okumadır: kaynak değiştirmez, tercih
   * yazmaz. Kaynak yoksa test verisine düşülmez.
   */
  async activeSnapshotForAdmin(admin: AdminActor, targetUserId: string): Promise<ActiveSnapshotResult> {
    return this.snapshotForScope(adminScope(admin, targetUserId));
  }

  private async snapshotForScope(scope: DataScope): Promise<ActiveSnapshotResult> {
    await this.ensureCatalog();
    const now = this.now();
    const providerCode = await this.resolveProviderCodeForScope(scope);
    if (!providerCode) {
      return {
        snapshot: null,
        source: {
          providerCode: null,
          displayName: "Fiyat kaynağı seçilmedi",
          technicalName: "",
          marketId: null,
          marketDisplayName: "",
          attribution: "",
          upstreamSourceLabel: null,
          isRealMarketData: false,
          lastQuoteAt: null,
          status: "not_selected",
          coverage: 0,
          userSelectable: false,
        },
      };
    }

    const row = await this.backend.currentPriceQuotes(providerCode);
    if (!row) {
      return {
        snapshot: null,
        source: {
          providerCode,
          displayName: describeProvider(providerCode)?.displayName ?? providerCode,
          technicalName: describeProvider(providerCode)?.technicalName ?? "",
          marketId: describeProvider(providerCode)?.marketId ?? null,
          marketDisplayName: describeProvider(providerCode)?.marketDisplayName ?? "",
          attribution: describeProvider(providerCode)?.attribution ?? "",
          upstreamSourceLabel: null,
          isRealMarketData: false,
          lastQuoteAt: null,
          status: "unavailable",
          coverage: 0,
          userSelectable: false,
        },
      };
    }

    const { snapshot, lastQuoteAt } = this.toSnapshot(row, now);
    const age = lastQuoteAt === null ? Number.POSITIVE_INFINITY : now - Date.parse(lastQuoteAt);
    const stale = age > staleAfterMs();
    const upstreamIds = new Set(
      row.quotes.map((quote) => quote.upstreamSourceId).filter((value): value is string => Boolean(value)),
    );
    const multiSource = describeProvider(providerCode)?.capabilities.includes("MULTI_SOURCE") ?? false;

    return {
      snapshot,
      source: {
        providerCode,
        displayName: row.displayName,
        technicalName: row.technicalName,
        marketId: row.marketId,
        marketDisplayName: row.marketDisplayName,
        attribution: row.attribution,
        // Üst kaynak tek ve biliniyorsa adı; bilinmiyorsa ve sağlayıcı çoklu ise "Çoklu Kaynak".
        upstreamSourceLabel:
          upstreamIds.size === 1 ? [...upstreamIds][0]! : multiSource ? "Çoklu Kaynak" : null,
        isRealMarketData: row.licenseStatus === "LICENSED",
        lastQuoteAt,
        status: row.quotes.length === 0 ? "unavailable" : stale ? "stale" : "ok",
        coverage: row.quotes.length,
        userSelectable: row.userSelectable,
      },
    };
  }

  /** Kullanıcı kaynağını değiştirir. Yalnızca yöneticinin açtığı kaynaklar seçilebilir. */
  async selectSource(actor: UserActor, providerCode: unknown, reason: unknown): Promise<{ changed: boolean; providerCode: string }> {
    if (typeof providerCode !== "string" || providerCode.trim() === "") {
      throw badRequest("Geçerli bir fiyat kaynağı seçin.");
    }
    const view = describeProvider(providerCode);
    if (!view) throw notFound("Fiyat kaynağı bulunamadı.");
    await this.ensureCatalog();
    if (providerCode === EXPERIMENTAL_SCREEN_CODE) {
      const allowed = await this.backend
        .experimentalAccessAllowed(actor.profile.id, EXPERIMENTAL_SCREEN_CODE)
        .catch(() => false);
      if (!allowed) {
        throw conflict("Bu deneysel kaynak sizin için açık değil. Yönetici izin vermelidir.");
      }
    }
    try {
      const result = await this.backend.setPricePreference(
        ownScope(actor),
        providerCode,
        actor.profile.id,
        "user",
        typeof reason === "string" ? reason.slice(0, 200) : "Kullanıcı seçimi",
      );
      return { changed: result.changed, providerCode: result.providerCode };
    } catch (error) {
      if (error instanceof ProviderNotSelectableError) throw conflict(error.message);
      throw error;
    }
  }

  /** Yönetici bir kullanıcının kaynağını değiştirir (denetim kaydı üretir). */
  async selectSourceForUser(
    admin: AdminActor,
    scopeUserId: string,
    providerCode: string,
    reason: string,
  ): Promise<{ changed: boolean; providerCode: string }> {
    await this.ensureCatalog();
    try {
      const result = await this.backend.setPricePreference(
        adminScope(admin, scopeUserId),
        providerCode,
        admin.profile.id,
        "admin",
        reason.slice(0, 200),
      );
      return { changed: result.changed, providerCode: result.providerCode };
    } catch (error) {
      if (error instanceof ProviderNotSelectableError) throw conflict(error.message);
      throw error;
    }
  }

  async listSourceEvents(actor: UserActor, limit = 20): Promise<PriceSourceEventRow[]> {
    await this.ensureCatalog();
    return this.backend.listPriceSourceEvents(ownScope(actor), limit);
  }

  /**
   * Karşılaştırma ekranı: birden çok kaynağın fiyatları.
   * Bu veriler DEĞERLEMEYE karışmaz; yalnızca gösterim içindir.
   */
  async compareSources(actor: UserActor): Promise<{
    activeProviderCode: string | null;
    providers: {
      providerCode: string;
      displayName: string;
      technicalName: string;
      marketDisplayName: string;
      isRealMarketData: boolean;
      health: string | null;
      active: boolean;
      selectable: boolean;
      quotes: {
        productId: string;
        liquidationPrice: string;
        replacementPrice: string;
        providerTimestamp: string;
        fetchedAt: string;
        status: string;
      }[];
    }[];
  }> {
    await this.ensureCatalog();
    const [providers, activeProviderCode] = await Promise.all([
      this.backend.listPriceProviders(),
      this.resolveActiveProviderCode(actor),
    ]);
    const visible = providers.filter(
      (provider) => provider.enabled && (provider.userSelectable || provider.code === activeProviderCode),
    );
    const rows = await this.backend.comparePriceQuotes(visible.map((provider) => provider.code));
    return {
      activeProviderCode,
      providers: rows.map((row) => ({
        providerCode: row.providerCode,
        displayName: row.displayName,
        technicalName: row.technicalName,
        marketDisplayName: row.marketDisplayName,
        isRealMarketData: row.licenseStatus === "LICENSED",
        health: row.health?.status ?? null,
        active: row.providerCode === activeProviderCode,
        selectable: row.userSelectable,
        quotes: row.quotes.map((quote) => ({
          productId: quote.canonicalProductId,
          liquidationPrice: quote.liquidationPrice,
          replacementPrice: quote.replacementPrice,
          providerTimestamp: quote.providerTimestamp,
          fetchedAt: quote.fetchedAt,
          status: quote.status,
        })),
      })),
    };
  }

  /** Yönetici ekranı: sağlayıcı listesi (kod tarafı lisans durumuyla birlikte). */
  async adminProviderState(): Promise<
    (Awaited<ReturnType<AuthBackend["listPriceProviders"]>>[number] & {
      runtimeLicenseStatus: string;
      selectable: boolean;
      blockedReason: string | null;
      missingConfig: readonly string[];
      /** Sağlayıcının sunduğunu söylediği ama bizde adapter'ı OLMAYAN yetenekler. */
      advertisedCapabilities: readonly string[];
      requiresPersistentWorker: boolean;
    })[]
  > {
    await this.ensureCatalog();
    const rows = await this.backend.listPriceProviders();
    const runtime = new Map(listProviderStatuses().map((view) => [view.providerId as string, view]));
    return rows.map((row) => {
      const view = runtime.get(row.code);
      return {
        ...row,
        runtimeLicenseStatus: view?.licenseStatus ?? row.licenseStatus,
        selectable: view?.selectable ?? false,
        blockedReason: view?.blockedReason ?? null,
        missingConfig: view?.missingConfig ?? [],
        advertisedCapabilities: view?.advertisedCapabilities ?? [],
        requiresPersistentWorker: view?.requiresPersistentWorker ?? false,
      };
    });
  }
}
