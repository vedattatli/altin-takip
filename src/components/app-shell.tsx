"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import type { SessionUser } from "@/auth/types";
import { appConfig } from "@/config/app.config";
import { apiFetch } from "@/lib/api-client";
import { BrandMark, cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  panel: <Icon path="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" />,
  transactions: <Icon path="M4 7h16M4 12h16M4 17h10" />,
  settings: (
    <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8.4-3a8.4 8.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a8.6 8.6 0 0 0-2.1-1.2L15.5 3h-4l-.4 2.6a8.6 8.6 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1c.65.5 1.36.9 2.1 1.2l.4 2.6h4l.4-2.6c.74-.3 1.45-.7 2.1-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z" />
  ),
  admin: (
    <Icon path="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm9-1 1.6 1.6L23 7" />
  ),
} as const;

/**
 * Gezinme öğeleri istemcide üretilir.
 *
 * Yönetim bağlantısının gizlenmesi bir GÜVENLİK önlemi DEĞİLDİR; yalnızca
 * arayüz sadeliği içindir. Yetki kontrolü sunucuda (AuthService) yapılır.
 */
function buildNavItems(role: SessionUser["role"] | null): NavItem[] {
  const items: NavItem[] = [
    { href: "/panel", label: "Panel", icon: ICONS.panel },
    { href: "/islemler", label: "İşlemler", icon: ICONS.transactions },
    { href: "/ayarlar", label: "Ayarlar", icon: ICONS.settings },
  ];
  if (role === "admin") {
    items.push({ href: "/yonetim", label: "Yönetim", icon: ICONS.admin });
  }
  return items;
}

export function AppShell({
  user,
  navItems: navItemsProp,
  badge,
  children,
}: {
  user: SessionUser | null;
  /** Verilmezse kullanıcının rolüne göre üretilir. */
  navItems?: NavItem[];
  /** Sağ üstte gösterilen mod rozeti (örn. Demo modu). */
  badge?: ReactNode;
  children: ReactNode;
}) {
  const navItems = navItemsProp ?? buildNavItems(user?.role ?? null);
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

  async function signOut() {
    setSigningOut(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      router.replace("/giris");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link href={navItems[0]?.href ?? "/"} className="flex items-center gap-2.5">
            <BrandMark size={30} />
            <span className="text-[0.9375rem] font-semibold tracking-tight text-ink">
              {appConfig.name}
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-2">
            {badge}
            {user ? (
              <div className="flex items-center gap-2">
                <span
                  className="hidden max-w-[10rem] truncate text-sm text-muted sm:inline"
                  title={user.displayName}
                >
                  {user.displayName}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary px-3 py-1.5 text-[0.8125rem]"
                  onClick={signOut}
                  disabled={signingOut}
                >
                  {signingOut ? "Çıkılıyor…" : "Çıkış"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-5 lg:py-8">
        {/* Masaüstü: yan gezinme */}
        <nav aria-label="Ana gezinme" className="hidden w-52 shrink-0 lg:block">
          <ul className="sticky top-20 space-y-1">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={cx(
                    "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition-colors",
                    isActive(item.href)
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-surface-3 hover:text-ink",
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main id="icerik" className="min-w-0 flex-1 pb-20 lg:pb-0">
          {children}
        </main>
      </div>

      {/* Mobil: alt sekme çubuğu */}
      <nav
        aria-label="Ana gezinme"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/97 backdrop-blur lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="mx-auto flex max-w-md">
          {navItems.map((item) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={cx(
                  "flex flex-col items-center gap-1 px-1 py-2.5 text-[0.6875rem] font-medium",
                  isActive(item.href) ? "text-accent" : "text-muted",
                )}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
