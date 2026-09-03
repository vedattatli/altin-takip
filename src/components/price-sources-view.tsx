"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { requireProduct } from "@/domain/catalog";
import { Alert, Card, SectionTitle, cx } from "./ui";

/**
 * KAYNAK SEÇİMİ VE KARŞILAŞTIRMA
 *
 * - Kullanıcı yalnızca yöneticinin açtığı kaynakları görür.
 * - Karşılaştırma ekranındaki fiyatlar DEĞERLEMEYE karışmaz.
 * - Kaynak değişimi açık onay ister ve denetim kaydı üretir.
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
  const [options, setOptions] = useState(initialOptions);
  const [active, setActive] = useState(initialActive);
  const [events, setEvents] = useState(initialEvents);
  const [compare, setCompare] = useState(initialCompare);
  const [pending, setPending] = useState<SourceOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirmChange() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/price-sources", {
        method: "POST",
        body: JSON.stringify({ providerCode: pending.providerCode, reason: "Kullanıcı seçimi" }),
      });
      const [next, nextCompare] = await Promise.all([
        apiFetch<{ options: SourceOption[]; active: ActiveSource; events: SourceChangeEvent[] }>("/api/price-sources"),
        apiFetch<{ activeProviderCode: string | null; providers: CompareProvider[] }>("/api/price-sources/compare"),
      ]);
      setOptions(next.options);
      setActive(next.active);
      setEvents(next.events);
      setCompare(nextCompare);
      setNotice(`Fiyat kaynağı "${pending.displayName}" olarak güncellendi. Geçmiş işlemleriniz değişmedi.`);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kaynak değiştirilemedi.");
    } finally {
      setBusy(false);
    }
  }

  const products = [
    ...new Set(compare.providers.flatMap((provider) => provider.quotes.map((quote) => quote.productId))),
  ].sort();

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Fiyat kaynağı"
        description="Portföyünüz tek bir piyasanın fiyatıyla değerlenir. Kaynak başarısız olursa başka bir piyasanın fiyatı gösterilmez."
      />

      <Card className="p-4" data-testid="active-source">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Aktif kaynak</p>
        <p className="mt-1 text-base font-semibold text-ink">{active.displayName}</p>
        <p className="mt-0.5 text-xs text-muted" title={active.technicalName}>
          {active.technicalName}
          {active.upstreamSourceLabel ? ` · ${active.upstreamSourceLabel}` : ""}
          {!active.isRealMarketData ? " · Gerçek piyasa verisi değil" : ""}
        </p>
        <p className="tabular mt-1 text-xs text-subtle">
          Durum: {STATUS_LABELS[active.status]}
          {active.lastQuoteAt ? ` · Son fiyat: ${formatDateTime(active.lastQuoteAt)}` : ""}
          {active.coverage > 0 ? ` · ${active.coverage} üründe fiyat` : ""}
        </p>
      </Card>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {pending ? (
        <Card className="border-accent-line space-y-3 p-4" data-testid="source-confirm">
          <p className="text-sm font-semibold text-ink">Fiyat kaynağı değiştirilsin mi?</p>
          <p className="text-sm text-muted">{SOURCE_CHANGE_WARNING}</p>
          <p className="text-sm text-ink">
            Yeni kaynak: <strong>{pending.displayName}</strong> ({pending.technicalName})
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn btn-secondary min-h-11" onClick={() => setPending(null)} disabled={busy}>
              Vazgeç
            </button>
            <button
              type="button"
              className="btn btn-primary min-h-11"
              data-testid="confirm-source-change"
              onClick={() => void confirmChange()}
              disabled={busy}
            >
              {busy ? "Değiştiriliyor…" : "Evet, değiştir"}
            </button>
          </div>
        </Card>
      ) : null}

      <Card>
        {options.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            Yönetici henüz seçilebilir bir fiyat kaynağı açmadı.
          </p>
        ) : (
          <ul data-testid="source-options">
            {options.map((option) => (
              <li key={option.providerCode} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    {option.displayName}{" "}
                    {option.active ? <span className="badge badge-positive">Aktif</span> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{option.technicalName}</p>
                  <p className="tabular mt-0.5 text-xs text-subtle">
                    {option.coverage} üründe fiyat
                    {option.lastSuccessAt ? ` · Son güncelleme ${formatDateTime(option.lastSuccessAt)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={cx("btn min-h-11", option.active ? "btn-secondary" : "btn-primary")}
                  disabled={option.active || busy}
                  data-testid={`select-${option.providerCode}`}
                  onClick={() => setPending(option)}
                >
                  {option.active ? "Kullanılıyor" : "Bu kaynağı kullan"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section>
        <SectionTitle
          title="Kaynakları karşılaştır"
          description="Bu tablodaki fiyatlar yalnızca bilgi içindir; portföy değerlemeniz aktif kaynakla hesaplanır."
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
                      {provider.displayName}
                      {provider.active ? " (aktif)" : ""}
                      <span className="block font-normal text-subtle">{provider.marketDisplayName}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((productId) => (
                  <tr key={productId} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-ink">{requireProduct(productId).name}</td>
                    {compare.providers.map((provider) => {
                      const quote = provider.quotes.find((candidate) => candidate.productId === productId);
                      return (
                        <td key={provider.providerCode} className="tabular px-3 py-2 text-muted">
                          {quote ? (
                            <>
                              <span className="block text-ink">{formatMoney(quote.liquidationPrice)}</span>
                              <span className="block">{formatMoney(quote.replacementPrice)}</span>
                              <span className="block text-subtle">
                                Makas {spread(quote.liquidationPrice, quote.replacementPrice)} ·{" "}
                                {formatDateTime(quote.providerTimestamp)}
                              </span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
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
