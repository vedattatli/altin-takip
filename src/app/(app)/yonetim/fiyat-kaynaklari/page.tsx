import type { Metadata } from "next";

import {
  AdminPriceSourcesView,
  type AdminProviderRow,
  type AdminQuarantineRow,
} from "@/components/admin/admin-price-sources-view";
import {
  getAdminService,
  getPriceIngestionService,
  getPriceSourceService,
  requireCurrentAdmin,
} from "@/server/auth";

export const metadata: Metadata = { title: "Fiyat kaynakları" };
export const dynamic = "force-dynamic";

export default async function AdminPriceSourcesPage() {
  const actor = await requireCurrentAdmin();
  // Katalog koddaki tanımlarla eşitlenir (idempotent); lisans durumu ortamdan gelir.
  await getPriceIngestionService().syncCatalog();
  const providers = (await getPriceSourceService().adminProviderState()) as unknown as AdminProviderRow[];
  // Karantina okunamazsa ekran yine açılır; liste boş gösterilir.
  const quarantine = (await getAdminService()
    .listPriceQuarantine(actor, null, 20)
    .catch(() => [])) as AdminQuarantineRow[];
  return <AdminPriceSourcesView initialProviders={providers} initialQuarantine={quarantine} />;
}
