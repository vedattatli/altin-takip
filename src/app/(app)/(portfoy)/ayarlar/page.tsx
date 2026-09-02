import type { Metadata } from "next";

import { toSessionUser } from "@/auth/types";
import { SettingsView } from "@/components/settings-view";
import { requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Ayarlar" };

export default async function SettingsPage() {
  const actor = await requireUsableUser();
  return <SettingsView user={toSessionUser(actor.profile)} />;
}
