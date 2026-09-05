import type { Metadata } from "next";

import {
  AdminPriceSourcesView,
  type AdminProviderRow,
  type AdminQuarantineRow,
} from "@/components/admin/admin-price-sources-view";
import { PLAN_PROVIDER_CODES } from "@/prices/valuation-plan";
import {
  getAdminService,
  getPriceIngestionService,
  getPriceSourceService,
  requireCurrentAdmin,
} from "@/server/auth";

export const metadata: Metadata = { title: "Fiyat kaynakları" };
export const dynamic = "force-dynamic";

/**
 * Ekranda gösterilecek kaynaklar. Katalogdaki diğer tanımlar hiç fiyat üretmiyor
 * (lisans sözleşmesi yok); satırları veritabanında kalır ama yöneticiye sayfa
 * dolduran boş kart olarak çizilmez. Liste değerleme planından okunur; sağlayıcı
 * kimlikleri burada ikinci kez yazılmaz.
 */
const DISPLAYED_PROVIDER_CODES = new Set<string>(PLAN_PROVIDER_CODES);

export default async function AdminPriceSourcesPage() {
  const actor = await requireCurrentAdmin();
  // Katalog koddaki tanımlarla eşitlenir (idempotent); lisans durumu ortamdan gelir.
  await getPriceIngestionService().syncCatalog();
  // Filtre yalnızca bu ekran içindir; servis bütün satırları döndürmeye devam eder.
  // `row.enabled` şarttır: fiilen fiyat besleyen hiçbir kaynak gizlenmez.
  const providers = (
    (await getPriceSourceService().adminProviderState()) as unknown as AdminProviderRow[]
  ).filter((row) => DISPLAYED_PROVIDER_CODES.has(row.code) || row.enabled);
  // Karantina okunamazsa ekran yine açılır; liste boş gösterilir.
  const quarantine = (await getAdminService()
    .listPriceQuarantine(actor, null, 20)
    .catch(() => [])) as AdminQuarantineRow[];
  return <AdminPriceSourcesView initialProviders={providers} initialQuarantine={quarantine} />;
}
