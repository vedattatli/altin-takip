import { numberFromEnv } from "@/lib/env";
import "server-only";

import { MOCK_PROVIDER_META } from "@/prices/mock-provider";
import {
  SCREEN_OBSERVATION_FRESH_MS,
  SCREEN_OBSERVATION_MAX_AGE_MS,
} from "@/prices/providers/sarraf-tv-screen-collector";
import { describeProvider, listProviderStatuses } from "@/prices/registry";
import type { PriceQuote, PriceSnapshot, PriceSourceMember } from "@/prices/types";
import {
  HYBRID_MARKET_ID,
  HYBRID_PROVIDER_ID,
  PLAN_PROVIDER_CODES,
  plannedProviderFor,
  SHARED_CATEGORY_QUOTE,
  VALUATION_PLAN_DESCRIPTION,
  VALUATION_PLAN_NAME,
  VALUATION_SOURCE_PLAN,
} from "@/prices/valuation-plan";
import { adminScope, ownScope, type AdminActor, type DataScope, type UserActor } from "@/server/auth/actor";
import type { AuthBackend } from "@/server/auth/backend";
import { badRequest, conflict, notFound } from "@/server/auth/errors";
import { PriceIngestionService } from "./ingestion-service";
import {
  ProviderNotSelectableError,
  type PriceSourceEventRow,
  type ProviderQuotesRow,
  type ScreenRawRow,
} from "./types";

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
/**
 * DENEYSEL KAYNAKLAR
 *
 * Hepsi izin listesine tabidir: hiçbiri genel kullanıcı listesine çıkamaz
 * (veritabanı kısıtı da bunu ayrıca engeller). Erişim portföy bazlıdır ve
 * kaynak BAŞINA verilir; bir kaynağa izin verilmesi diğerini açmaz.
 */
const EXPERIMENTAL_CODES = PLAN_PROVIDER_CODES;

function isExperimentalCode(code: string): boolean {
  return (EXPERIMENTAL_CODES as readonly string[]).includes(code);
}

const EXPERIMENTAL_SCREEN_CODE = "sarraf-tv-kayseri-screen";

/**
 * HİBRİT PLANDA BAYATLIK EŞİKLERİ
 *
 * Kaynakların kendi güncelleme sıklığı değil, BİZİM toplama sıklığımız
 * belirler: ücretsiz bulut toplayıcısı saatte bir çalışır. Eşik toplama
 * aralığından dar olsaydı her fiyat, henüz doğruyken bile "bayat" görünürdü.
 *
 * 0–90 dk    Güncel
 * 90+ dk     Bayat (arayüzde açıkça bayat yazar, değerlemeye girmez)
 */
const PLAN_STALE_AFTER_MS: Readonly<Record<string, number>> = {
  "sarraf-tv-kayseri-screen": SCREEN_OBSERVATION_FRESH_MS,
  "anlik-altin-kapalicarsi": SCREEN_OBSERVATION_FRESH_MS,
  "truncgil-turkiye": SCREEN_OBSERVATION_FRESH_MS,
};

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
  /**
   * Hibrit planda gerçekten fiyat veren sağlayıcı kodları.
   * Tek sağlayıcılı klasik yolda boştur.
   */
  planProviderCodes?: readonly string[];
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

/**
 * Etkinleştirilebilir lisans durumları — veritabanı kısıtı
 * (`price_providers_enabled_requires_license`) ve `setPriceProviderFlags` ile
 * AYNI liste. Üç yerde ayrı ayrı yazılırsa biri diğerinden sapar.
 */
const ACTIVATABLE_LICENSE_STATUS: readonly string[] = ["LICENSED", "DEV_ONLY", "EXPERIMENTAL_PRIVATE"];

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
    // Deneysel kaynaklar yalnızca izin listesindeki kullanıcıya görünür ve
    // izin KAYNAK BAŞINA denetlenir.
    const experimentalAllowed = new Map<string, boolean>();
    await Promise.all(
      EXPERIMENTAL_CODES.map(async (code) => {
        const allowed = await this.backend
          .experimentalAccessAllowed(actor.profile.id, code)
          .catch(() => false);
        experimentalAllowed.set(code, allowed);
      }),
    );

    return providers
      .filter((provider) => {
        if (!provider.enabled) return false;
        if (provider.licenseStatus === "EXPERIMENTAL_PRIVATE") {
          return isExperimentalCode(provider.code) && experimentalAllowed.get(provider.code) === true;
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
      if (!isExperimentalCode(preference.providerCode)) return preference.providerCode;
      // İzin geri alındıysa deneysel kaynak kullanılmaz. BAŞKA KAYNAĞA DA
      // GEÇİLMEZ: kaynak yok sayılır ve değerleme boş kalır.
      const allowed = await this.backend
        .experimentalAccessAllowed(scope.userId, preference.providerCode)
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
          // Yalnız test sağlayıcısı uydurma veridir.
          isTestData: row.licenseStatus === "DEV_ONLY",
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
   * KAYSERİ EKRANINDA GÖRÜNEN BÜTÜN HAM SATIRLAR
   *
   * Ekranda ne yazıyorsa onu gösterir. Bir satırın burada görünmesi, o fiyatın
   * portföy hesabına girdiği anlamına GELMEZ — `usedInValuation` bunu satır
   * satır söyler.
   *
   * Erişim izni olmayan kullanıcıya boş döner: deneysel kaynak yalnız
   * yöneticinin izin listesindeki portföylere açıktır.
   */
  async kayseriScreenRows(actor: UserActor): Promise<{
    rows: ScreenRawRow[];
    observedAt: string | null;
    screenSignature: string;
    /** Gözlem yaşına göre: "fresh" | "stale" | "unusable" | "none" */
    freshness: "fresh" | "stale" | "unusable" | "none";
    ageMinutes: number | null;
    allowed: boolean;
  }> {
    const allowed = await this.backend
      .experimentalAccessAllowed(actor.profile.id, EXPERIMENTAL_SCREEN_CODE)
      .catch(() => false);
    if (!allowed) {
      return { rows: [], observedAt: null, screenSignature: "", freshness: "none", ageMinutes: null, allowed: false };
    }

    const snapshot = await this.backend.screenRows(EXPERIMENTAL_SCREEN_CODE);
    if (!snapshot || snapshot.rows.length === 0) {
      return { rows: [], observedAt: null, screenSignature: "", freshness: "none", ageMinutes: null, allowed: true };
    }

    const observedMs = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observedMs)) {
      return {
        rows: snapshot.rows,
        observedAt: null,
        screenSignature: snapshot.screenSignature,
        freshness: "none",
        ageMinutes: null,
        allowed: true,
      };
    }

    const ageMs = Math.max(0, this.now() - observedMs);
    const ageMinutes = Math.floor(ageMs / 60_000);
    // Zamanlanmış bulut toplayıcısı saatte bir çalışır ve gecikebilir.
    const freshness = ageMs <= SCREEN_OBSERVATION_FRESH_MS ? "fresh" : ageMs <= SCREEN_OBSERVATION_MAX_AGE_MS ? "stale" : "unusable";

    return {
      rows: snapshot.rows,
      observedAt: snapshot.observedAt,
      screenSignature: snapshot.screenSignature,
      freshness,
      ageMinutes,
      allowed: true,
    };
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

  /**
   * HİBRİT KAYSERİ DEĞERLEMESİ
   *
   * Ürün başına kaynak `valuation-plan.ts` içinde ÖNCEDEN yazılıdır. Burada
   * yalnızca plan uygulanır:
   *
   *   - Her ürünün fiyatı YALNIZ kendi planlanmış sağlayıcısından alınır.
   *   - Planlanan sağlayıcı veri vermiyorsa ürün fiyatsız kalır; başka
   *     sağlayıcının fiyatı o ürüne YAZILMAZ.
   *   - Alış ve satış hep aynı kaydın iki alanıdır; karıştırılamaz.
   *   - Kullanıcının izni olmayan kaynak plana girmez.
   *
   * Kullanıcının hiçbir plan kaynağına izni yoksa null döner ve klasik
   * tek-sağlayıcılı yol kullanılır.
   */
  private async hybridSnapshotForScope(scope: DataScope, now: number): Promise<ActiveSnapshotResult | null> {
    const allowedCodes: string[] = [];
    await Promise.all(
      PLAN_PROVIDER_CODES.map(async (code) => {
        const allowed = await this.backend.experimentalAccessAllowed(scope.userId, code).catch(() => false);
        if (allowed) allowedCodes.push(code);
      }),
    );
    if (allowedCodes.length === 0) return null;

    const rows = await this.backend.comparePriceQuotes(allowedCodes);
    const byProvider = new Map(rows.map((row) => [row.providerCode, row]));

    const quotes: Record<string, PriceQuote> = {};
    const memberProviders: Record<string, PriceSourceMember> = {};
    const usedProviders = new Set<string>();
    let newest: number | null = null;

    for (const productId of Object.keys(VALUATION_SOURCE_PLAN)) {
      const providerCode = plannedProviderFor(productId);
      if (providerCode === null) continue;
      if (!allowedCodes.includes(providerCode)) continue;
      const row = byProvider.get(providerCode);
      if (!row) continue;

      // Ürünün kendi kaydı; yoksa ORTAK KATEGORİ fiyatı (aynı sağlayıcıdan).
      const own = row.quotes.find((quote) => quote.canonicalProductId === productId);
      const sharedFromId = SHARED_CATEGORY_QUOTE[productId];
      const shared =
        own === undefined && sharedFromId !== undefined && plannedProviderFor(sharedFromId) === providerCode
          ? row.quotes.find((quote) => quote.canonicalProductId === sharedFromId)
          : undefined;
      const source = own ?? shared;
      if (!source) continue;

      const memberStaleAfterMs = PLAN_STALE_AFTER_MS[providerCode] ?? staleAfterMs();
      memberProviders[productId] = {
        provider: providerCode,
        market: row.marketId,
        staleAfterMs: memberStaleAfterMs,
        ...(own === undefined && shared !== undefined ? { sharedFrom: sharedFromId } : {}),
      };
      quotes[productId] = {
        productId,
        liquidationPrice: source.liquidationPrice,
        replacementPrice: source.replacementPrice,
        currency: "TRY",
        market: row.marketId,
        provider: providerCode,
        providerTimestamp: source.providerTimestamp,
        fetchedAt: source.fetchedAt,
        status: source.status === "ok" ? "ok" : "stale",
      };
      usedProviders.add(providerCode);

      const parsed = Date.parse(source.fetchedAt);
      if (Number.isFinite(parsed)) newest = newest === null ? parsed : Math.max(newest, parsed);
    }

    const productCount = Object.keys(quotes).length;
    const snapshotStaleAfter = Math.max(
      ...allowedCodes.map((code) => PLAN_STALE_AFTER_MS[code] ?? staleAfterMs()),
    );
    const fetchedAt = newest === null ? new Date(now).toISOString() : new Date(newest).toISOString();

    return {
      snapshot: {
        provider: {
          id: HYBRID_PROVIDER_ID,
          label: VALUATION_PLAN_NAME,
          market: HYBRID_MARKET_ID,
          // Gerçek piyasa verisidir ama LİSANSLI değildir: kaynakların hiçbiri
          // yeniden gösterim izni beyan etmiyor. Bu ayrım kullanıcıya
          // sağlayıcı açıklamasında yazılır — "uydurma veri" denmez.
          isRealMarketData: false,
          isTestData: false,
          disclaimer: VALUATION_PLAN_DESCRIPTION,
          staleAfterMs: snapshotStaleAfter,
          memberProviders,
        },
        quotes,
        fetchedAt,
        status: productCount === 0 ? "unavailable" : "ok",
        error:
          productCount === 0
            ? "Planlanan fiyat kaynaklarından kullanılabilir fiyat alınamadı. Başka bir kaynağın fiyatı gösterilmez."
            : null,
      },
      source: {
        providerCode: HYBRID_PROVIDER_ID,
        displayName: VALUATION_PLAN_NAME,
        technicalName: VALUATION_PLAN_DESCRIPTION,
        marketId: HYBRID_MARKET_ID,
        marketDisplayName: "Kayseri + referans kaynaklar",
        attribution: VALUATION_PLAN_DESCRIPTION,
        upstreamSourceLabel: null,
        isRealMarketData: false,
        lastQuoteAt: newest === null ? null : new Date(newest).toISOString(),
        status:
          productCount === 0
            ? "unavailable"
            : newest !== null && now - newest > snapshotStaleAfter
              ? "stale"
              : "ok",
        coverage: productCount,
        // Plan kullanıcı tarafından değiştirilmez; teknik kaynak seçimi yoktur.
        userSelectable: false,
        planProviderCodes: [...usedProviders],
      },
    };
  }

  private async snapshotForScope(scope: DataScope): Promise<ActiveSnapshotResult> {
    await this.ensureCatalog();
    const now = this.now();
    const hybrid = await this.hybridSnapshotForScope(scope, now);
    if (hybrid) return hybrid;
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

    /*
     * Kullanıcının izinli olduğu PLAN kaynakları da karşılaştırmaya girer.
     *
     * Plan kaynakları bilerek "kullanıcıya açık" değildir (genel listede
     * seçilemezler). Yalnız `userSelectable` bakılsaydı karşılaştırma tablosu
     * tek sütuna düşer ve kaynaklar arasındaki fark görünmez olurdu — oysa
     * kullanıcının görmesi gereken tam olarak bu farktır.
     *
     * Bu tablo YALNIZCA gösterimdir; değerlemeyi değiştirmez.
     */
    const planAllowed = new Set<string>();
    await Promise.all(
      PLAN_PROVIDER_CODES.map(async (code) => {
        const allowed = await this.backend.experimentalAccessAllowed(actor.profile.id, code).catch(() => false);
        if (allowed) planAllowed.add(code);
      }),
    );

    const visible = providers.filter(
      (provider) =>
        provider.enabled &&
        (provider.userSelectable || provider.code === activeProviderCode || planAllowed.has(provider.code)),
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
      /**
       * Bu kaynak ETKİNLEŞTİRİLEBİLİR mi? `selectable` ile karıştırılmamalıdır:
       * `selectable` "kullanıcı genel listeden seçebilir mi", `canEnable` ise
       * "sistem bu kaynaktan fiyat çekebilir mi" demektir.
       *
       * Deneysel kaynakta `selectable` HER ZAMAN false'tur (genel listeye
       * çıkmaz) ama etkinleştirilebilir. Yönetim ekranı ikisini karıştırdığı
       * için deneysel bir kaynak arayüzden hiç açılamıyordu: düğme sürekli
       * devre dışıydı, üretimde Kapalıçarşı kaynağı bu yüzden kapalı kaldı ve
       * gram altın fiyatsız göründü.
       *
       * Kural sunucudakiyle (`setPriceProviderFlags`) aynıdır.
       */
      canEnable: boolean;
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
        canEnable:
          ACTIVATABLE_LICENSE_STATUS.includes(row.licenseStatus) &&
          !(row.licenseStatus === "LICENSED" && !row.redistributionAllowed),
        blockedReason: view?.blockedReason ?? null,
        missingConfig: view?.missingConfig ?? [],
        advertisedCapabilities: view?.advertisedCapabilities ?? [],
        requiresPersistentWorker: view?.requiresPersistentWorker ?? false,
      };
    });
  }
}
