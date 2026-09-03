import type { ReactNode } from "react";
import Link from "next/link";
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
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2" aria-label="Yönetim bölümleri">
        <Link href="/yonetim" className="btn btn-secondary min-h-11">
          Kullanıcılar
        </Link>
        <Link href="/yonetim/fiyat-kaynaklari" className="btn btn-secondary min-h-11">
          Fiyat kaynakları
        </Link>
        <Link href="/yonetim/deneysel-kaynak" className="btn btn-secondary min-h-11">
          Deneysel kaynak
        </Link>
      </nav>
      {children}
    </div>
  );
}
