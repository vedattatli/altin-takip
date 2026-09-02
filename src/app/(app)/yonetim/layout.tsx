import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Yönetim alanı koruması.
 *
 * Bu yönlendirme yalnızca arayüz kolaylığıdır. Asıl yetki kontrolü her admin
 * API çağrısında AuthService.requireAdmin ile yeniden yapılır.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const profile = await getCurrentUser();
  if (!profile) redirect("/giris");
  if (profile.role !== "admin") redirect("/panel");
  return <>{children}</>;
}
