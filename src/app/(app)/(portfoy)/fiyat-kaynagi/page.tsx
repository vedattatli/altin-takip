import type { Metadata } from "next";

import { PriceListView } from "@/components/price-list-view";
import { PriceSourcesView } from "@/components/price-sources-view";
import { PriceTabs } from "@/components/price-tabs";
import { getPriceSourceService, requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Fiyatlar" };
export const dynamic = "force-dynamic";

export default async function PriceSourcePage() {
  const actor = await requireUsableUser();
  const service = getPriceSourceService();
  const [options, active, compare] = await Promise.all([
    service.listSelectableSources(actor),
    service.activeSnapshot(actor),
    service.compareSources(actor),
  ]);
  return (
    <div className="space-y-6">
      <PriceTabs />
      {/*
        Fiyatlar ÖNCE gelir: kullanıcı bu sayfaya "ne kaça alınıp satılıyor"
        diye bakar. Kaynak seçimi ve karşılaştırma altta kalır.
      */}
      <PriceListView snapshot={active.snapshot} />
      <PriceSourcesView
        initialOptions={options}
        initialActive={active.source}
        initialCompare={compare}
      />
    </div>
  );
}
