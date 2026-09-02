"use client";

import { useState } from "react";

import { AppShell } from "./app-shell";
import { DashboardView } from "./dashboard-view";
import { TransactionsView } from "./transactions-view";
import { Alert, cx } from "./ui";

/**
 * Demo çalışma alanı — YALNIZCA geliştirme ortamında erişilebilir.
 *
 * Gerçek bir hesap değildir. Veriler yalnızca bu tarayıcının IndexedDB
 * deposunda tutulur, sunucuya gitmez ve cihazlar arasında senkronize olmaz.
 */
export function DemoWorkspace() {
  const [tab, setTab] = useState<"panel" | "islemler">("panel");

  return (
    <AppShell
      user={null}
      navItems={[]}
      badge={<span className="badge badge-notice">Demo modu</span>}
    >
      <div className="space-y-5">
        <Alert tone="notice" title="Demo modu — gerçek hesap değil">
          Bu ekrandaki veriler yalnızca bu tarayıcıda saklanır. Sunucuya kaydedilmez, başka
          cihazlarınızda görünmez ve gerçek bir kullanıcı hesabı oluşturmaz. Fiyatlar test
          verisidir.
        </Alert>

        <div role="tablist" aria-label="Demo bölümleri" className="flex gap-2">
          {(
            [
              ["panel", "Panel"],
              ["islemler", "İşlemler"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cx(
                "rounded-[var(--radius-sm)] border px-3.5 py-2 text-sm font-semibold transition-colors",
                tab === id
                  ? "border-accent-line bg-accent-soft text-accent"
                  : "border-line bg-surface text-muted hover:bg-surface-3",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "panel" ? (
          <DashboardView onAdd={() => setTab("islemler")} />
        ) : (
          <TransactionsView />
        )}
      </div>
    </AppShell>
  );
}
