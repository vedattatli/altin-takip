import type { Metadata } from "next";

import {
  AdminScreenSourceView,
  type ApprovalRow,
  type WorkerStateView,
} from "@/components/admin/admin-screen-source-view";
import { Alert } from "@/components/ui";
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
  // Okuma hatası ekranı kapatmasın; hata üstte AÇIKÇA yazılır. Boş liste ile
  // okunamayan liste aynı şey değildir: ikincisini sahibine söylemek zorundayız.
  const [workerSettled, approvalsSettled] = await Promise.allSettled([
    admin.screenWorkerState(actor, SCREEN_CODE) as Promise<WorkerStateView | null>,
    admin.listMappingApprovals(actor, SCREEN_CODE) as Promise<ApprovalRow[]>,
  ]);
  const worker = workerSettled.status === "fulfilled" ? workerSettled.value : null;
  const approvals = approvalsSettled.status === "fulfilled" ? approvalsSettled.value : [];
  const readFailed = workerSettled.status === "rejected" || approvalsSettled.status === "rejected";

  return (
    <div className="space-y-4">
      {readFailed ? (
        <Alert tone="danger">
          Yönetim verisi okunamadı. Aşağıdaki liste eksik olabilir; “yok” yazan yerler “okunamadı”
          anlamına gelir.
        </Alert>
      ) : null}
      <AdminScreenSourceView
        initialWorker={worker}
        initialApprovals={approvals}
        products={GOLD_PRODUCTS.map((product) => ({ id: product.id, name: product.name }))}
        mappingVersion={SARRAF_TV_SCREEN_MAPPING_VERSION}
      />
    </div>
  );
}
