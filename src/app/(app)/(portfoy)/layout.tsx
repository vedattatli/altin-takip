import type { ReactNode } from "react";

import { PortfolioProvider } from "@/state/portfolio-store";

/** Portföy ekranları hesap deposunu kullanır (cihazlar arasında senkron). */
export default function PortfolioLayout({ children }: { children: ReactNode }) {
  return <PortfolioProvider mode="account">{children}</PortfolioProvider>;
}
