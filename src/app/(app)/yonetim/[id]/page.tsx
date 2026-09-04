import type { Metadata } from "next";

import { AdminUserDetail } from "@/components/admin/admin-user-detail";
import { getAdminService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Kullanıcı" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireCurrentAdmin();
  // Görüntüleme denetim kaydı bu çağrı içinde yazılır. Portföy verisi
  // ÇEKİLMEZ: yönetici kullanıcının altın varlığını görmez.
  const view = await getAdminService().getUserAccount(actor, id);
  const sessions = await getAdminService().listUserSessions(actor, id);
  return (
    <AdminUserDetail
      initial={view}
      initialSessions={sessions}
      isSelf={actor.profile.id === view.user.id}
    />
  );
}
