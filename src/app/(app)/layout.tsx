import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { toSessionUser } from "@/auth/types";
import { AppShell } from "@/components/app-shell";
import { CsrfMeta } from "@/components/csrf-meta";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { getSessionContext } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Oturum koruması.
 *
 * Bu, arayüz katmanındaki ilk savunmadır. Asıl yetkilendirme her API
 * çağrısında sunucu tarafında ayrıca doğrulanır. Oturum kalıcıdır; istemci
 * tarafında hareketsizlik sayacı veya otomatik çıkış YOKTUR.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect("/giris");
  if (session.profile.mustChangePassword) redirect("/parola-degistir");

  return (
    <>
      <CsrfMeta />
      <AppShell user={toSessionUser(session.profile)}>{children}</AppShell>
      {/* Servis çalışanı yalnızca oturum içinde ve üretim derlemesinde kaydedilir. */}
      <ServiceWorkerRegistrar />
    </>
  );
}
