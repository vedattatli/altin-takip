import type { Metadata } from "next";

import { KayseriPricesView } from "@/components/kayseri-prices-view";
import { getPriceSourceService, requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Kayseri fiyatları" };
export const dynamic = "force-dynamic";

/**
 * KAYSERİ FİYATLARI
 *
 * Sarraf TV Kayseri ekranındaki BÜTÜN ham satırları gösterir. Ekranda ne
 * yazıyorsa o görünür; hangi satırın portföy hesabına girdiği satır satır
 * ayrıca belirtilir. İkisi AYRI kavramdır.
 */
export default async function KayseriPricesPage() {
  const actor = await requireUsableUser();
  const snapshot = await getPriceSourceService().kayseriScreenRows(actor);
  return <KayseriPricesView snapshot={snapshot} />;
}
