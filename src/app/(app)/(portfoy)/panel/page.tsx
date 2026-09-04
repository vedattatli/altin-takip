import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard-view";
import { KayseriLivePanel } from "@/components/kayseri-live-panel";
import { getPriceSourceService, requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Panel" };
export const dynamic = "force-dynamic";

/**
 * PORTFÖY PANELİ
 *
 * Masaüstünde iki sütun: solda portföy, sağda dar "Kayseri Canlı Altın
 * Ekranı". Panelin verisi sunucuda doğrulanmış SON GÖZLEMDİR; kullanıcının
 * tarayıcısı fiyat kaynağına bağlanmaz.
 *
 * Ekran erişimi olmayan kullanıcıda panel hiç render edilmez ve düzen tek
 * sütuna döner.
 */
export default async function PanelPage() {
  const actor = await requireUsableUser();
  const screen = await getPriceSourceService().kayseriScreenRows(actor);

  return (
    <div className="dashboard-grid" data-testid="dashboard-grid">
      <div className="min-w-0">
        <DashboardView addHref="/islemler" />
      </div>
      <KayseriLivePanel snapshot={screen} />
    </div>
  );
}
