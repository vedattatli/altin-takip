import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BrandMark } from "@/components/ui";
import { appConfig } from "@/config/app.config";
import { getCurrentUser } from "@/server/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Giriş" };

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/parola-degistir" : "/panel");

  return (
    <main id="icerik" className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={52} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{appConfig.name}</h1>
          <p className="mt-1.5 text-sm text-muted">{appConfig.tagline}</p>
        </div>

        <div className="card p-5 sm:p-6">
          <LoginForm />
        </div>

        {/*
          Herkese açık kayıt YOKTUR. Hesaplar yalnızca yönetici tarafından
          oluşturulur; bu ekranda kayıt bağlantısı bulunmaz.
        */}
        <p className="mt-5 text-center text-xs leading-relaxed text-subtle">
          Hesaplar yönetici tarafından oluşturulur. Kullanıcı adınızı veya parolanızı
          bilmiyorsanız sistem yöneticinizle iletişime geçin.
        </p>
      </div>
    </main>
  );
}
