import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CsrfMeta } from "@/components/csrf-meta";
import { BrandMark } from "@/components/ui";
import { appConfig } from "@/config/app.config";
import { getCurrentUser } from "@/server/auth";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Hesap oluştur" };

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/parola-degistir" : "/panel");

  return (
    <main id="icerik" className="flex flex-1 items-center justify-center px-4 py-10">
      <CsrfMeta />
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={52} />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Hesap oluştur</h1>
          <p className="mt-1.5 text-sm text-muted">{appConfig.name}</p>
        </div>

        <div className="card p-5 sm:p-6">
          <RegisterForm />
        </div>

        {/*
          PAROLA KURTARMA UYARISI BİLEREK BURADA.

          Uygulamanın e-posta veya SMS kanalı yoktur; "şifremi unuttum" akışı
          bu yüzden YOKTUR. Parolasını unutan kullanıcıyı yalnızca yönetici
          sıfırlayabilir. Bunu kayıt anında söylemek, sonradan öğrenmekten
          iyidir.
        */}
        <p className="mt-5 text-center text-xs leading-relaxed text-subtle">
          Parolanızı unutursanız kendiniz sıfırlayamazsınız; yöneticiyle iletişime geçmeniz
          gerekir. Parolanızı güvenli bir yerde saklayın.
        </p>

        <p className="mt-4 text-center text-sm text-muted">
          Zaten hesabınız var mı?{" "}
          <Link href="/giris" className="font-medium text-accent hover:underline">
            Giriş yapın
          </Link>
        </p>
      </div>
    </main>
  );
}
