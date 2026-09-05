"use client";

import { GOLD_PRODUCTS } from "@/domain/catalog";
import type { ProductCategory } from "@/domain/types";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { PriceSnapshot } from "@/prices/types";
import { lastKnownQuote } from "@/prices/validate";
import { sourceBadgeFor } from "@/prices/valuation-plan";
import { useClientClock } from "./price-source-line";
import { Card, SectionTitle } from "./ui";

/**
 * FİYAT LİSTESİ — VARLIK TÜRÜNE GÖRE.
 *
 * Kullanıcı geri bildirimi: "görünen/görünmeyen değil, düzgün bir liste
 * olsun; altın başlığı altında altınlar, gümüş başlığı altında gümüş, para
 * başlığı altında dolar euro."
 *
 * Bu ekran KAYNAK ekranı değildir; hangi ürünün şu an kaç liradan alınıp
 * satıldığını gösterir. Kaynak seçimi ve karşılaştırma aşağıda kalır.
 *
 * Fiyatı olmayan ürün GİZLENMEZ, "—" ile gösterilir. Gizlemek, kullanıcıya
 * o ürünün var olmadığını düşündürürdü; oysa bilinmeyen şey yalnızca fiyat.
 */

/*
 * Başlık sırası ve adları, "Varlık türü" açılır listesiyle AYNIDIR
 * (`SELECT_GROUPS`, ledger-forms.tsx). İki ekranda farklı sıra veya farklı ad
 * kullanmak, aynı katalogu iki ayrı şeymiş gibi gösterirdi.
 */
const GROUPS: readonly { id: string; title: string; categories: readonly ProductCategory[] }[] = [
  { id: "altin", title: "Altınlar", categories: ["gram", "kulce", "ayarli", "ziynet"] },
  { id: "doviz", title: "Döviz", categories: ["doviz"] },
  { id: "gumus", title: "Gümüş", categories: ["gumus"] },
];

/**
 * Yukarıdaki listede adı geçmeyen bir kategori eklenirse ürünleri bu başlık
 * altında görünür. Aksi hâlde yeni bir kategori bu ekrandan SESSİZCE düşerdi
 * ve kimse fark etmezdi.
 */
const GROUPED_CATEGORIES = new Set(GROUPS.flatMap((group) => group.categories));

function Row({
  name,
  buy,
  sell,
  source,
  asOf,
}: {
  name: string;
  buy: string | null;
  sell: string | null;
  source: string | null;
  /** Fiyat bayatsa ait olduğu an; tazeyse null. */
  asOf: string | null;
}) {
  return (
    <tr className="border-t border-line" data-testid="price-row">
      <td className="py-2 pr-2">
        <span className="text-sm font-medium text-ink">{name}</span>
        {source ? <span className="mt-0.5 block text-[11px] text-subtle">{source}</span> : null}
        {/*
          Piyasa kapalıyken kaynak yeni fiyat yayımlamaz. Son bilinen fiyat
          gösterilir ama "güncel" DENMEZ: hangi ana ait olduğu satırda yazar.
        */}
        {asOf ? (
          <span className="mt-0.5 block text-[11px] text-subtle" data-testid="price-as-of">
            {formatDateTime(asOf)} itibarıyla
          </span>
        ) : null}
      </td>
      <td className="tabular py-2 pr-2 text-right text-sm text-ink">
        {buy === null ? <span className="text-subtle">—</span> : formatMoney(buy)}
      </td>
      <td className="tabular py-2 text-right text-sm text-muted">
        {sell === null ? <span className="text-subtle">—</span> : formatMoney(sell)}
      </td>
    </tr>
  );
}

export function PriceListView({
  snapshot,
  serverNow,
}: {
  snapshot: PriceSnapshot | null;
  serverNow?: string;
}) {
  const clock = useClientClock(30_000);
  /*
   * İstemci saati gelmeden (sunucu render'ı ve hidrasyon) sunucudan geçirilen
   * gerçek zaman kullanılır; hidrasyon bozulmasın diye Date.now() çağrılmaz.
   *
   * Anlık görüntünün KENDİ zamanına düşmek son çaredir: o durumda fiyatın yaşı
   * sıfır çıkar ve bayatlık kapısı (validate.ts) sunucuda hiç tetiklenmez, yani
   * günler öncesinin fiyatı ilk HTML'de güncelmiş gibi basılır. Bunu önlemek
   * için sayfa `serverNow={new Date().toISOString()}` geçirmelidir.
   */
  const serverNowMs = Date.parse(serverNow ?? "");
  const snapshotMs = Date.parse(snapshot?.fetchedAt ?? "");
  const fallback = Number.isFinite(serverNowMs) ? serverNowMs : snapshotMs;
  const now = clock ?? (Number.isFinite(fallback) ? fallback : 0);

  const groups = GROUPS.map((group) => ({
    ...group,
    products: GOLD_PRODUCTS.filter((product) => group.categories.includes(product.category)).map(
      (product) => {
        const found = lastKnownQuote(snapshot, product.id, now);
        const member = snapshot?.provider.memberProviders?.[product.id];
        return {
          id: product.id,
          name: product.name,
          buy: found?.quote.liquidationPrice ?? null,
          sell: found?.quote.replacementPrice ?? null,
          source: sourceBadgeFor(member?.provider)?.label ?? null,
          // Piyasa kapalıyken son bilinen fiyat gösterilir; yaşı satırda yazar.
          asOf: found?.stale === true ? found.asOf : null,
        };
      },
    ),
  })).filter((group) => group.products.length > 0);

  const ungrouped = GOLD_PRODUCTS.filter((product) => !GROUPED_CATEGORIES.has(product.category));
  if (ungrouped.length > 0) {
    groups.push({
      id: "diger",
      title: "Diğer",
      categories: [],
      products: ungrouped.map((product) => {
        const found = lastKnownQuote(snapshot, product.id, now);
        const member = snapshot?.provider.memberProviders?.[product.id];
        return {
          id: product.id,
          name: product.name,
          buy: found?.quote.liquidationPrice ?? null,
          sell: found?.quote.replacementPrice ?? null,
          source: sourceBadgeFor(member?.provider)?.label ?? null,
          // Piyasa kapalıyken son bilinen fiyat gösterilir; yaşı satırda yazar.
          asOf: found?.stale === true ? found.asOf : null,
        };
      }),
    });
  }

  return (
    <section className="space-y-4" data-testid="price-list">
      <SectionTitle
        title="Fiyatlar"
        description="Bozdurma kuyumcuya satış, yeniden alım kuyumcudan alış fiyatıdır."
      />

      {groups.map((group) => (
        <Card key={group.id} className="overflow-hidden">
          <p className="border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-subtle">
            {group.title}
          </p>
          <div className="overflow-x-auto px-4 pb-2">
            <table className="w-full min-w-[280px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-subtle">
                  <th className="py-2 pr-2 text-left font-medium">Ürün</th>
                  <th className="py-2 pr-2 text-right font-medium">Bozdurma</th>
                  <th className="py-2 text-right font-medium">Yeniden alım</th>
                </tr>
              </thead>
              <tbody>
                {group.products.map((product) => (
                  <Row
                    key={product.id}
                    name={product.name}
                    buy={product.buy}
                    sell={product.sell}
                    source={product.source}
                    asOf={product.asOf}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </section>
  );
}
