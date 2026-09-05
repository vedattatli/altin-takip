import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CsrfMeta } from "@/components/csrf-meta";
import { BrandMark } from "@/components/ui";
import { getSessionContext } from "@/server/auth";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Parola değiştir" };

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const session = await getSessionContext();
  if (!session) redirect("/giris");
  const user = session.profile;

  return (
    <main id="icerik" className="flex flex-1 items-center justify-center px-4 py-10">
      <CsrfMeta />
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={44} />
          <h1 className="mt-3.5 text-xl font-semibold tracking-tight text-ink">
            Parolanızı belirleyin
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Hesap: <span className="font-medium text-ink">{user.username}</span>
          </p>
        </div>

        <div className="card p-5 sm:p-6">
          <ChangePasswordForm forced={user.mustChangePassword} />
        </div>

        {/* Zorunlu değişimde dönülecek bir yer yok; ayarlardan gelen kullanıcı vazgeçebilir. */}
        {user.mustChangePassword ? null : (
          <Link href="/ayarlar" className="mt-3 block text-center text-sm text-muted">
            Vazgeç
          </Link>
        )}
      </div>
    </main>
  );
}
