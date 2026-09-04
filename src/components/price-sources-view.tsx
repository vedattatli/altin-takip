"use client";

import { useState } from "react";

import { requireProduct } from "@/domain/catalog";
import { formatDateTime, formatMoney } from "@/lib/format";
import {
  displayProductName,
  PRIMARY_DISPLAY_GROUPS,
  plannedProviderFor,
  SHARED_CATEGORY_NOTE,
  sourceBadgeFor,
  VALUATION_PLAN_DESCRIPTION,
  VALUATION_PLAN_NAME,
  VALUATION_SOURCE_PLAN,
} from "@/prices/valuation-plan";
import { Alert, Card, SectionTitle } from "./ui";

/**
 * FİYAT KAYNAKLARI — BİLGİ EKRANI
 *
 * Normal kullanıcıdan teknik sağlayıcı seçmesi İSTENMEZ. Tek bir değerleme
 * planı vardır ve bu ekran yalnızca planı görünür kılar:
 *
 *   - hangi ürünün fiyatı hangi kaynaktan geliyor,
 *   - kaynaklar en son ne zaman güncellendi,
 *   - kaynaklar arasındaki fark ne kadar.
 *
 * Karşılaştırma tablosundaki fiyatlar DEĞERLEMEYE karışmaz; yalnız bilgidir.
 * Teknik sağlayıcı kimliği, lisans durumu ve güven seviyeleri burada da
 * gösterilmez — bunlar yönetim ekranının konusudur.
 */

export interface SourceOption {
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

export interface ActiveSource {
  providerCode: string | null;
  displayName: string;
  technicalName: string;
  marketDisplayName: string;
  upstreamSourceLabel: string | null;
  isRealMarketData: boolean;
  lastQuoteAt: string | null;
  status: "ok" | "stale" | "unavailable" | "not_selected";
  coverage: number;
  userSelectable: boolean;
  planProviderCodes?: readonly string[];
}

export interface SourceChangeEvent {
  changedAt: string;
  previousProviderCode: string | null;
  newProviderCode: string | null;
  changedByRole: "user" | "admin";
  reason: string;
}

export interface CompareProvider {
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
}

export const SOURCE_CHANGE_WARNING =
  "Fiyat kaynağını değiştirmek güncel portföy değerinizi ve görünen gerçekleşmemiş kâr/zararı değiştirebilir. " +
  "Geçmiş işlem maliyetleriniz ve başlangıç snapshot'larınız değişmez.";

const STATUS_LABELS: Record<ActiveSource["status"], string> = {
  ok: "Güncel",
  stale: "Bayat",
  unavailable: "Fiyat verisi kullanılamıyor",
  not_selected: "Kaynak seçilmedi",
};

function spread(liquidation: string, replacement: string): string {
  const low = Number(liquidation);
  const high = Number(replacement);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0) return "—";
  return `%${(((high - low) / low) * 100).toFixed(2)}`;
}

/** Altı ana ürün için "hangi kaynak" tablosu. */
function PlanTable() {
  return (
    <table className="w-full text-left text-xs" data-testid="plan-table">
      <thead className="text-subtle">
        <tr className="border-b border-line">
          <th className="px-3 py-2 font-semibold">Ürün</th>
          <th className="px-3 py-2 font-semibold">Fiyat kaynağı</th>
        </tr>
      </thead>
      <tbody>
        {PRIMARY_DISPLAY_GROUPS.map((group) => {
          const badge = sourceBadgeFor(plannedProviderFor(group.primaryProductId));
          return (
            <tr key={group.id} className="border-b border-line last:border-b-0">
              <td className="px-3 py-2 font-medium text-ink">{group.label}</td>
              <td className="px-3 py-2 text-muted">
                {badge ? badge.label : "—"}
                {badge ? <span className="block text-subtle">{badge.description}</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PriceSourcesView({
  initialOptions,
  initialActive,
  initialEvents,
  initialCompare,
}: {
  initialOptions: SourceOption[];
  initialActive: ActiveSource;
  initialEvents: SourceChangeEvent[];
  initialCompare: { activeProviderCode: string | null; providers: CompareProvider[] };
}) {
  const [options] = useState(initialOptions);
  const [active] = useState(initialActive);
  const [events] = useState(initialEvents);
  const [compare] = useState(initialCompare);

  const products = [
    ...new Set(compare.providers.flatMap((provider) => provider.quotes.map((quote) => quote.productId))),
  ].sort();

  const planned = new Set(Object.keys(VALUATION_SOURCE_PLAN));

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Fiyat kaynağı"
        description="Portföyünüz tek bir değerleme planıyla hesaplanır. Bir ürünün alış ve satış fiyatı her zaman aynı kaynaktan gelir."
      />

      <Card className="p-4" data-testid="active-source">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Değerleme planı</p>
        <p className="mt-1 text-base font-semibold text-ink">{VALUATION_PLAN_NAME}</p>
        <p className="mt-0.5 break-words text-xs text-muted">{VALUATION_PLAN_DESCRIPTION}</p>
        <p className="tabular mt-1 text-xs text-subtle">
          Durum: {STATUS_LABELS[active.status]}
          {active.lastQuoteAt ? ` · Son fiyat: ${formatDateTime(active.lastQuoteAt)}` : ""}
          {active.coverage > 0 ? ` · ${active.coverage} üründe fiyat` : ""}
        </p>
      </Card>

      <Card className="overflow-x-auto">
        <PlanTable />
      </Card>

      <Alert tone="info">
        Bir kaynak veri veremezse o ürünün fiyatı <strong>bayat</strong> veya{" "}
        <strong>kullanılamıyor</strong> gösterilir; başka bir kaynağın fiyatı o ürüne yazılmaz.{" "}
        {SHARED_CATEGORY_NOTE}
      </Alert>

      {options.length > 0 ? (
        <section>
          <SectionTitle title="Kaynak durumu" description="Her kaynağın en son ne zaman güncellendiği." />
          <Card>
            <ul data-testid="source-options">
              {options.map((option) => {
                const badge = sourceBadgeFor(option.providerCode);
                return (
                  <li
                    key={option.providerCode}
                    className="border-b border-line px-4 py-3 last:border-b-0"
                    data-testid={`source-${option.providerCode}`}
                  >
                    <p className="text-sm font-semibold text-ink">{badge?.label ?? option.displayName}</p>
                    <p className="tabular mt-0.5 text-xs text-subtle">
                      {option.coverage} üründe fiyat
                      {option.lastSuccessAt ? ` · Son güncelleme ${formatDateTime(option.lastSuccessAt)}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle
          title="Kaynakları karşılaştır"
          description="Bu tablodaki fiyatlar yalnızca bilgi içindir; portföyünüz yukarıdaki planla hesaplanır."
        />
        <Card className="overflow-x-auto">
          {products.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Karşılaştırılacak fiyat verisi yok.</p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-xs" data-testid="compare-table">
              <thead>
                <tr className="border-b border-line text-subtle">
                  <th className="px-3 py-2 font-semibold">Ürün</th>
                  {compare.providers.map((provider) => (
                    <th key={provider.providerCode} className="px-3 py-2 font-semibold">
                      {sourceBadgeFor(provider.providerCode)?.label ?? provider.displayName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((productId) => {
                  const plannedCode = plannedProviderFor(productId);
                  return (
                    <tr key={productId} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-2 text-ink">
                        {displayProductName(productId, requireProduct(productId).name, { distinguish: true })}
                        {planned.has(productId) ? null : (
                          <span className="block text-subtle">değerlemede kullanılmıyor</span>
                        )}
                      </td>
                      {compare.providers.map((provider) => {
                        const quote = provider.quotes.find((candidate) => candidate.productId === productId);
                        const isPlanned = provider.providerCode === plannedCode;
                        return (
                          <td key={provider.providerCode} className="tabular px-3 py-2 text-muted">
                            {quote ? (
                              <>
                                <span className="block text-ink">{formatMoney(quote.liquidationPrice)}</span>
                                <span className="block">{formatMoney(quote.replacementPrice)}</span>
                                <span className="block text-subtle">
                                  Makas {spread(quote.liquidationPrice, quote.replacementPrice)}
                                  {isPlanned ? " · hesapta kullanılan" : ""}
                                </span>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      {events.length > 0 ? (
        <section>
          <SectionTitle title="Kaynak değişiklikleri" />
          <Card>
            <ul data-testid="source-events">
              {events.map((event) => (
                <li key={event.changedAt} className="border-b border-line px-4 py-2 text-xs text-muted last:border-b-0">
                  {formatDateTime(event.changedAt)} · {event.previousProviderCode ?? "—"} →{" "}
                  {event.newProviderCode ?? "—"} ({event.changedByRole === "admin" ? "yönetici" : "kullanıcı"})
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
