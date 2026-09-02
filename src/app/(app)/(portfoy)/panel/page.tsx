import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard-view";

export const metadata: Metadata = { title: "Panel" };

export default function PanelPage() {
  return <DashboardView addHref="/islemler" />;
}
