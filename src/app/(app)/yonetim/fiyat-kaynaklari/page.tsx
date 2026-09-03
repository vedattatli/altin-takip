import type { Metadata } from "next";

import { AdminPriceSourcesView, type AdminProviderRow } from "@/components/admin/admin-price-sources-view";
import { getPriceIngestionService, getPriceSourceService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Fiyat kaynakları" };
export const dynamic = "force-dynamic";

export default async function AdminPriceSourcesPage() {
  await requireCurrentAdmin();
  // Katalog koddaki tanımlarla eşitlenir (idempotent); lisans durumu ortamdan gelir.
  await getPriceIngestionService().syncCatalog();
  const providers = (await getPriceSourceService().adminProviderState()) as unknown as AdminProviderRow[];
  return <AdminPriceSourcesView initialProviders={providers} />;
}
