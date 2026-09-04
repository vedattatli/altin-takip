import "server-only";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { NormalizedQuote } from "@/prices/contract";
import {
  collectScreenQuotes,
  SCREEN_OBSERVATION_MAX_AGE_MS,
  type CollectorObservation,
} from "@/prices/providers/sarraf-tv-screen-collector";
import {
  approvalAppliesToCurrentMapping,
  type MappingConfidence,
} from "@/prices/providers/sarraf-tv-screen-mapping";
import { evaluateSnapshot } from "@/prices/quality";
import type { AuthBackend } from "@/server/auth/backend";
import type { IngestionPayload, ScreenRawRow, ScreenWorkerPayload, WorkerLeaseState } from "./types";

/**
 * EKRAN WORKER'I → UYGULAMA
 *
 * Worker yalnızca GÖZLEM gönderir. Veritabanına yazma kararını bu servis verir:
 * worker'ın "bu fiyat geçerli" demesine GÜVENİLMEZ, merkezî kalite kapısı ve
 * eşleme onayları burada yeniden uygulanır.
 *
 * Kira (lease) doğrulaması split-brain'i engeller: kirayı elinde tutmayan veya
 * eski kira jetonuyla gelen worker'ın gönderisi reddedilir.
 */

export const SCREEN_PROVIDER_CODE = "sarraf-tv-kayseri-screen";
export const WORKER_LEASE_TTL_SECONDS = 180;

const KNOWN_PRODUCT_IDS = new Set(GOLD_PRODUCTS.map((product) => product.id));

export type WorkerIngestFailure =
  | "LEASE_NOT_HELD"
  | "LEASE_TOKEN_STALE"
  | "PROVIDER_DISABLED"
  | "COLLECTOR_REJECTED";

export interface WorkerIngestResult {
  ok: boolean;
  failure?: WorkerIngestFailure;
  status: string;
  accepted: number;
  quarantined: number;
  unresolved: { rawProductName: string; reason: string }[];
  message: string;
}

/** Kira jetonu: sahip + kiranın alındığı an. Devralma sonrası eski jeton geçersizdir. */
export function leaseTokenOf(state: WorkerLeaseState | null): string | null {
  if (!state) return null;
  return `${state.workerId}:${state.acquiredAt}`;
}

export class ScreenWorkerService {
  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Worker kirayı alır veya yeniler; jeton döner. */
  async acquireLease(workerId: string): Promise<{ held: boolean; leaseToken: string | null; takeover: boolean }> {
    const result = await this.backend.acquireWorkerLease(SCREEN_PROVIDER_CODE, workerId, WORKER_LEASE_TTL_SECONDS);
    const state = await this.backend.workerLeaseState(SCREEN_PROVIDER_CODE);
    return { held: result.held, leaseToken: result.held ? leaseTokenOf(state) : null, takeover: result.takeover };
  }

  async leaseState(): Promise<WorkerLeaseState | null> {
    return this.backend.workerLeaseState(SCREEN_PROVIDER_CODE);
  }

  /** Yönetici onaylı eşlemeler: ürün → güven seviyesi. */
  private async approvedMappings(): Promise<Map<string, MappingConfidence>> {
    const rows = await this.backend.listMappingApprovals(SCREEN_PROVIDER_CODE);
    const map = new Map<string, MappingConfidence>();
    for (const row of rows) {
      if (!approvalAppliesToCurrentMapping(row.mappingVersion, row.canonicalProductId)) continue;
      map.set(row.canonicalProductId, "OPERATOR_VERIFIED");
    }
    return map;
  }

  /**
   * Worker gözlemini uygular.
   *
   * Sıra: kira → toplayıcı (onaylı eşleme + gözlem yaşı) → merkezî kalite kapısı
   * (gözlem zamanı politikasıyla) → ingestion RPC. Her adım fail closed'dır.
   */
  async ingest(payload: ScreenWorkerPayload, leaseToken: string, runKey: string): Promise<WorkerIngestResult> {
    const state = await this.backend.workerLeaseState(SCREEN_PROVIDER_CODE);
    if (!state || !state.active || state.workerId !== payload.workerId) {
      return {
        ok: false,
        failure: "LEASE_NOT_HELD",
        status: "REJECTED",
        accepted: 0,
        quarantined: 0,
        unresolved: [],
        message: "Bu worker sağlayıcı kirasını elinde tutmuyor.",
      };
    }
    if (leaseTokenOf(state) !== leaseToken) {
      return {
        ok: false,
        failure: "LEASE_TOKEN_STALE",
        status: "REJECTED",
        accepted: 0,
        quarantined: 0,
        unresolved: [],
        message: "Kira jetonu eskimiş; kira devralınmış olabilir.",
      };
    }

    const approved = await this.approvedMappings();
    const observations: CollectorObservation[] = payload.observations.map((observation) => ({
      canonicalProductId: observation.canonicalProductId,
      mappingConfidence: observation.mappingConfidence as MappingConfidence,
      liquidationPrice: observation.liquidationPrice,
      replacementPrice: observation.replacementPrice,
      observedAt: observation.observedAt,
    }));

    const collected = collectScreenQuotes({
      headers: payload.headers,
      observations,
      unresolved: payload.unresolved,
      captchaSeen: payload.captchaSeen,
      ingestionRunId: runKey,
      approvedMappings: approved,
      now: () => this.now(),
    });

    // HAM SATIRLARI SAKLA — kabul edilen fiyat olmasa BİLE.
    // "Kayseri Fiyatları" ekranının asıl gerekli olduğu durum tam olarak budur:
    // hiçbir fiyat değerlemeye girmese de kullanıcı ekranda ne yazdığını görür.
    await this.persistScreenRows(payload, collected, approved);

    if (collected.quotes.length === 0) {
      return {
        ok: true,
        failure: "COLLECTOR_REJECTED",
        status: collected.status,
        accepted: 0,
        quarantined: 0,
        unresolved: collected.unresolved,
        message: collected.message,
      };
    }

    // MERKEZÎ KALİTE KAPISI: worker'ın kararına güvenilmez.
    const previous = await this.previousLiquidationMap();
    const quality = evaluateSnapshot(collected.quotes, {
      providerId: "sarraf-tv-kayseri-screen",
      marketId: "kayseri",
      knownProductIds: KNOWN_PRODUCT_IDS,
      now: this.now(),
      previousLiquidation: (productId) => previous.get(productId) ?? null,
      observedTimePolicy: {
        providerId: "sarraf-tv-kayseri-screen",
        maxObservationAgeMs: SCREEN_OBSERVATION_MAX_AGE_MS,
      },
    });

    const ingestionPayload: IngestionPayload = {
      status: quality.accepted.length === 0 ? "unavailable" : quality.quarantined.length > 0 ? "partial" : "ok",
      safeErrorCode: payload.captchaSeen ? "CAPTCHA_OR_INTERACTION_REQUIRED" : null,
      latencyMs: null,
      fetchedAt: payload.observedAt,
      quotes: quality.accepted.map((quote: NormalizedQuote) => ({
        canonicalProductId: quote.canonicalProductId,
        liquidationPrice: quote.liquidationPrice,
        replacementPrice: quote.replacementPrice,
        upstreamSourceId: quote.upstreamSourceId,
        // Ekran kaynak zamanı yayımlamıyor: gözlem anı taşınır ve UI'da
        // "kaynak zamanı" olarak DEĞİL, "son ekran gözlemi" olarak gösterilir.
        providerTimestamp: quote.fetchedAt,
        fetchedAt: quote.fetchedAt,
        status: "ok",
        mappingVersion: quote.mappingVersion,
        rawPayloadHash: null,
      })),
      quarantined: quality.quarantined.map((entry) => ({
        canonicalProductId: entry.quote.canonicalProductId,
        code: entry.code,
        liquidationPrice: entry.quote.liquidationPrice ?? null,
        replacementPrice: entry.quote.replacementPrice ?? null,
        currency: entry.quote.currency ?? null,
        providerTimestamp: null,
        fetchedAt: entry.quote.fetchedAt ?? null,
        mappingVersion: entry.quote.mappingVersion ?? null,
        rawPayloadHash: null,
      })),
    };

    const result = await this.backend.applyPriceIngestion(SCREEN_PROVIDER_CODE, runKey, ingestionPayload);
    return {
      ok: true,
      status: result.status,
      accepted: quality.accepted.length,
      quarantined: quality.quarantined.length,
      unresolved: collected.unresolved,
      message: `${quality.accepted.length} fiyat uygulandı, ${quality.quarantined.length} karantinaya alındı.`,
    };
  }

  /**
   * Ekranda görünen bütün ham satırları saklar.
   *
   * Görünmek ile değerlemede kullanılmak AYRI kavramlardır:
   *  - `usedInValuation` yalnız kalite kapısından geçenler için true olur,
   *  - tek yönlü satırlarda rakam `single` alanına yazılır ve alış/satış BOŞ
   *    kalır; aynı değeri iki yöne birden koymak yön uydurmak olurdu.
   *
   * Saklama başarısız olursa fiyat alımı DURDURULMAZ: bu gösterim amaçlı bir
   * yan kayıttır ve muhasebeyi etkilemez.
   */
  private async persistScreenRows(
    payload: ScreenWorkerPayload,
    collected: { quotes: readonly NormalizedQuote[]; unresolved: readonly { rawProductName: string; reason: string }[] },
    approved: ReadonlyMap<string, MappingConfidence>,
  ): Promise<void> {
    /*
     * BOŞ GÖZLEM SON İYİ SATIRLARIN ÜSTÜNE YAZILMAZ.
     *
     * ÖLÇÜLDÜ (2026-09-04T05:26Z): sayfa yavaş açıldığında tablo yapısı hazır,
     * fiyat hücreleri boş gelir. O koşumda 12 satırın 12'si çözülemedi
     * (`products:0`) ve bu boş liste kaydedildi — panelde bütün fiyatlar "—"
     * oldu, kullanıcı uygulamayı bozuk sandı.
     *
     * Tek bir ürün bile çözülememişse elimizde "ekranda fiyat yok" bilgisi
     * değil, HİÇ BİLGİ yoktur. Böyle bir durumda eskiyi silmek, bilmediğimizi
     * bilgiymiş gibi kaydetmek olur. Worker da artık bunu göndermiyor; bu
     * ikinci savunma hattıdır (eski bir worker sürümü hâlâ gönderebilir).
     */
    if (payload.observations.length === 0) return;

    const accepted = new Set(collected.quotes.map((quote) => quote.canonicalProductId));
    const rows: ScreenRawRow[] = [];

    for (const observation of payload.observations) {
      const twoSided = observation.liquidationPrice !== null && observation.replacementPrice !== null;
      rows.push({
        rawLabel: observation.rawLabel ?? observation.canonicalProductId,
        buy: twoSided ? observation.liquidationPrice : null,
        sell: twoSided ? observation.replacementPrice : null,
        single: twoSided ? null : (observation.liquidationPrice ?? observation.replacementPrice ?? null),
        canonicalProductId: observation.canonicalProductId,
        /*
         * ETKİN güven yazılır, ham eşleme güveni değil.
         *
         * Yönetici onayı CONVENTION'ı OPERATOR_VERIFIED'a yükseltir ve fiyat
         * bu sayede değerlemeye girer. Ham güven yazıldığında ekranda
         * "Piyasa teamülü — onay olmadan hesaba girmez" çıkıyordu; oysa satır
         * tam da hesaba giriyordu. Aynı satır hem "giriyor" hem "girmiyor"
         * diyordu.
         */
        confidence: approved.get(observation.canonicalProductId) ?? observation.mappingConfidence,
        usedInValuation: accepted.has(observation.canonicalProductId),
        reason: accepted.has(observation.canonicalProductId)
          ? null
          : (collected.unresolved.find((entry) => entry.rawProductName === observation.canonicalProductId)?.reason ??
            "DEGERLEMEYE_GIRMEDI"),
      });
    }

    // Çözülemeyen ham satırlar da gösterilir: kullanıcı ekranda ne olduğunu
    // görür, ama bunlar hesaba KATILMAZ.
    for (const entry of payload.unresolved) {
      // Ekranda okunan rakamlar gösterilir ama YÖN ATFEDİLMEZ.
      // Tek rakam varsa "tek yönlü referans"; birden fazlaysa hiçbiri alış
      // veya satış diye etiketlenmez, çünkü kaynak bunu yayımlamıyor.
      const values = entry.observedValues ?? [];
      rows.push({
        rawLabel: entry.rawProductName,
        buy: null,
        sell: null,
        single: values.length === 1 ? values[0] : null,
        canonicalProductId: null,
        confidence: null,
        usedInValuation: false,
        reason: entry.reason,
        observedValues: values.length > 1 ? values : null,
      });
    }

    try {
      await this.backend.setScreenRows(
        SCREEN_PROVIDER_CODE,
        rows,
        payload.screenSignature ?? "",
        payload.observedAt,
      );
    } catch {
      // Gösterim kaydı yazılamadı; fiyat alımı etkilenmez.
    }
  }

  /** Devre kesici referansı: aynı sağlayıcının güncel kabul edilmiş fiyatları. */
  private async previousLiquidationMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const row = await this.backend.currentPriceQuotes(SCREEN_PROVIDER_CODE);
      if (!row) return map;
      for (const quote of row.quotes) {
        if (quote.status !== "ok") continue;
        const value = Number(quote.liquidationPrice);
        if (Number.isFinite(value) && value > 0) map.set(quote.canonicalProductId, value);
      }
    } catch {
      return new Map();
    }
    return map;
  }
}
