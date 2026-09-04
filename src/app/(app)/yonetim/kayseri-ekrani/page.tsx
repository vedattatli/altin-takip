import type { Metadata } from "next";

import {
  AdminScreenSourceView,
  type ApprovalRow,
  type WorkerStateView,
} from "@/components/admin/admin-screen-source-view";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import { SARRAF_TV_SCREEN_MAPPING_VERSION } from "@/prices/providers/sarraf-tv-screen-mapping";
import { getAdminService, getPriceIngestionService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Kayseri ekranı" };
export const dynamic = "force-dynamic";

const SCREEN_CODE = "sarraf-tv-kayseri-screen";

export default async function AdminScreenSourcePage() {
  const actor = await requireCurrentAdmin();
  await getPriceIngestionService().syncCatalog();

  const admin = getAdminService();
  // Okuma hatası ekranı kapatmasın; liste boş gösterilir.
  const [worker, approvals] = await Promise.all([
    admin.screenWorkerState(actor, SCREEN_CODE).catch(() => null) as Promise<WorkerStateView | null>,
    admin.listMappingApprovals(actor, SCREEN_CODE).catch(() => []) as Promise<ApprovalRow[]>,
  ]);

  return (
    <AdminScreenSourceView
      initialWorker={worker}
      initialApprovals={approvals}
      products={GOLD_PRODUCTS.map((product) => ({ id: product.id, name: product.name }))}
      mappingVersion={SARRAF_TV_SCREEN_MAPPING_VERSION}
    />
  );
}
