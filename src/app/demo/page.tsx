import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DemoWorkspace } from "@/components/demo-workspace";
import { serverEnv } from "@/server/env";
import { PortfolioProvider } from "@/state/portfolio-store";

export const metadata: Metadata = { title: "Demo" };

export const dynamic = "force-dynamic";

/**
 * Demo modu yalnızca geliştirme ortamında ve NEXT_PUBLIC_ENABLE_DEMO_MODE=true
 * iken açılır. Üretim derlemesinde bu sayfa 404 döner ve giriş ekranında
 * herhangi bir demo bağlantısı gösterilmez.
 */
export default function DemoPage() {
  if (!serverEnv.demoModeEnabled) notFound();

  return (
    <PortfolioProvider mode="demo">
      <DemoWorkspace />
    </PortfolioProvider>
  );
}
