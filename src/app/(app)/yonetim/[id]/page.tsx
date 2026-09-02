import type { Metadata } from "next";

import { AdminUserDetail } from "@/components/admin/admin-user-detail";
import { getAuthService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Kullanıcı" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireCurrentAdmin();
  // Görüntüleme denetim kaydı bu çağrı içinde yazılır.
  const view = await getAuthService().getUserPortfolio(actor, id);
  return <AdminUserDetail initial={view} isSelf={actor.id === view.user.id} />;
}
