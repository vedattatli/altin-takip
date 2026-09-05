"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "./ui";

/**
 * FİYAT EKRANLARI ARASI SEKMELER.
 *
 * "Fiyat kaynağı" ve "Kayseri ekranı" gezinmede iki ayrı madde olarak
 * duruyordu; ikisi de fiyat ekranı olduğu için hangisinin ne olduğu
 * anlaşılmıyordu. Artık gezinmede TEK madde var, ikisi arasında burada
 * geçiliyor.
 *
 * Adresler korunur: eski bağlantılar ve yer imleri çalışmaya devam eder.
 */
const TABS = [
  { href: "/fiyat-kaynagi", label: "Fiyat listesi" },
  { href: "/kayseri-fiyatlari", label: "Kayseri ekranı" },
] as const;

export function PriceTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Fiyat ekranları">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "min-h-11 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
