import type { Metadata } from "next";

import { AdminUserDetail } from "@/components/admin/admin-user-detail";
import { getAdminService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Kullanıcı" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireCurrentAdmin();
  // Görüntüleme denetim kaydı bu çağrı içinde yazılır.
  const view = await getAdminService().getUserPortfolio(actor, id);
  return <AdminUserDetail initial={view} isSelf={actor.profile.id === view.user.id} />;
}
