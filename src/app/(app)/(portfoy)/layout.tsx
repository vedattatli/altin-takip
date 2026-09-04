import type { ReactNode } from "react";

import { PortfolioProvider } from "@/state/portfolio-store";
import { ViewModeProvider, ViewModeToggle } from "@/state/view-mode";

/**
 * Portföy ekranları hesap deposunu kullanır (cihazlar arasında senkron).
 *
 * Görünüm modu (basit/detaylı) burada sarmalanır ki tek düğme bütün portföy
 * ekranlarını birlikte değiştirsin.
 */
export default function PortfolioLayout({ children }: { children: ReactNode }) {
  return (
    <PortfolioProvider mode="account">
      <ViewModeProvider>
        {children}
        <ViewModeToggle />
      </ViewModeProvider>
    </PortfolioProvider>
  );
}
