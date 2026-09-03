import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminMfaView } from "@/components/admin/admin-mfa-view";
import { CsrfMeta } from "@/components/csrf-meta";
import { getMfaService, getSessionContext } from "@/server/auth";

export const metadata: Metadata = { title: "Güvenlik doğrulaması" };
export const dynamic = "force-dynamic";

/**
 * Yönetici ikinci faktör ekranı.
 *
 * (app) düzeninin DIŞINDADIR: yönetici MFA'yı tamamlamadan uygulama kabuğuna
 * giremez, bu sayfa da yönlendirme döngüsüne girmez.
 */
export default async function SecurityPage() {
  const session = await getSessionContext();
  if (!session) redirect("/giris");
  if (session.profile.mustChangePassword) redirect("/parola-degistir");
  if (session.profile.role !== "admin") redirect("/panel");

  const status = await getMfaService().status(session.profile, session.mfaVerifiedAt);
  if (status.state === "enrolled" && status.sessionVerified) redirect("/yonetim");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-4 py-10">
      <CsrfMeta />
      <AdminMfaView initialStatus={status} username={session.profile.username} />
    </div>
  );
}
