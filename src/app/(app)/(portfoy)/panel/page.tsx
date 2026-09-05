import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard-view";
import { requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Panel" };
export const dynamic = "force-dynamic";

/**
 * PORTFÖY PANELİ
 *
 * Tek sütun: yalnızca kullanıcının kendi portföyü. Ham fiyat ekranı ayrı
 * sayfada durur (/kayseri-fiyatlari); panelde portföyle yarışan ikinci bir
 * fiyat kaynağı gösterilmez.
 *
 * Panelin verisi sunucuda doğrulanmış SON GÖZLEMDİR; kullanıcının tarayıcısı
 * fiyat kaynağına bağlanmaz.
 */
export default async function PanelPage() {
  await requireUsableUser();

  return (
    <div className="min-w-0" data-testid="dashboard-grid">
      <DashboardView addHref="/islemler" />
    </div>
  );
}
