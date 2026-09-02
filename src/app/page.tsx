import { redirect } from "next/navigation";

import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Kök adres: oturuma göre panele veya giriş ekranına yönlendirir. */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/giris");
  redirect(user.mustChangePassword ? "/parola-degistir" : "/panel");
}
