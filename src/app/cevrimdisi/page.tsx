import type { Metadata } from "next";

import { BrandMark } from "@/components/ui";
import { appConfig } from "@/config/app.config";

export const metadata: Metadata = { title: "İnternet bağlantısı yok" };

export default function OfflinePage() {
  return (
    <main id="icerik" className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <BrandMark size={44} />
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">
          İnternet bağlantısı yok
        </h1>
        <p className="mt-2 text-sm text-muted">
          {appConfig.name} şu anda bağlanamıyor; bağlantınız gelince sayfayı yenileyin.
        </p>
      </div>
    </main>
  );
}
