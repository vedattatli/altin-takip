import type { Metadata } from "next";

import { AdminUsersView } from "@/components/admin/admin-users-view";
import { getAuthService, requireCurrentAdmin } from "@/server/auth";

export const metadata: Metadata = { title: "Yönetim" };

export default async function AdminPage() {
  const actor = await requireCurrentAdmin();
  const users = await getAuthService().listUsers(actor);
  return <AdminUsersView initialUsers={users} />;
}
