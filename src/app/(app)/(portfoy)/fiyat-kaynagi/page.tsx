import type { Metadata } from "next";

import { PriceSourcesView } from "@/components/price-sources-view";
import { getPriceSourceService, requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Fiyat kaynağı" };
export const dynamic = "force-dynamic";

export default async function PriceSourcePage() {
  const actor = await requireUsableUser();
  const service = getPriceSourceService();
  const [options, active, events, compare] = await Promise.all([
    service.listSelectableSources(actor),
    service.activeSnapshot(actor),
    service.listSourceEvents(actor, 10),
    service.compareSources(actor),
  ]);
  return (
    <PriceSourcesView
      initialOptions={options}
      initialActive={active.source}
      initialEvents={events}
      initialCompare={compare}
    />
  );
}
