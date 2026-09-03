import type { Metadata } from "next";

import {
  AdminExperimentalView,
  type AccessRow,
  type ApprovalRow,
  type WorkerStateView,
} from "@/components/admin/admin-experimental-view";
import { GOLD_PRODUCTS } from "@/domain/catalog";
import { experimentalScreenAllowed } from "@/prices/dev-gate";
import { SARRAF_TV_SCREEN_MAPPING_VERSION } from "@/prices/providers/sarraf-tv-screen-mapping";
import { getAdminService, getPriceIngestionService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Deneysel kaynak" };
export const dynamic = "force-dynamic";

const SCREEN_CODE = "sarraf-tv-kayseri-screen";

export default async function AdminExperimentalPage() {
  const actor = await requireCurrentAdmin();
  await getPriceIngestionService().syncCatalog();

  const admin = getAdminService();
  // Okuma hatası ekranı kapatmasın; liste boş gösterilir.
  const [access, worker, approvals, users] = await Promise.all([
    admin.listExperimentalAccess(actor, SCREEN_CODE).catch(() => []) as Promise<AccessRow[]>,
    admin.screenWorkerState(actor, SCREEN_CODE).catch(() => null) as Promise<WorkerStateView | null>,
    admin.listMappingApprovals(actor, SCREEN_CODE).catch(() => []) as Promise<ApprovalRow[]>,
    admin.listUsers(actor).catch(() => []),
  ]);

  return (
    <AdminExperimentalView
      initialWorker={worker}
      initialAccess={access}
      initialApprovals={approvals}
      users={users.map((user) => ({ id: user.id, username: user.username, displayName: user.displayName }))}
      products={GOLD_PRODUCTS.map((product) => ({ id: product.id, name: product.name }))}
      mappingVersion={SARRAF_TV_SCREEN_MAPPING_VERSION}
      enabledInEnvironment={experimentalScreenAllowed()}
    />
  );
}
