import type { Metadata } from "next";

import { toSessionUser } from "@/auth/types";
import { SettingsView } from "@/components/settings-view";
import { requireCurrentUser } from "@/server/auth";

export const metadata: Metadata = { title: "Ayarlar" };

export default async function SettingsPage() {
  const profile = await requireCurrentUser();
  return <SettingsView user={toSessionUser(profile)} />;
}
