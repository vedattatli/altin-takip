import type { Metadata } from "next";

import { BrandMark } from "@/components/ui";
import { appConfig } from "@/config/app.config";

export const metadata: Metadata = { title: "Çevrimdışısınız" };

export default function OfflinePage() {
  return (
    <main id="icerik" className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <BrandMark size={44} />
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">Çevrimdışısınız</h1>
        <p className="mt-2 text-sm text-muted">
          {appConfig.name} şu anda internete bağlanamıyor. Bu sayfa çevrimdışı olduğunuz için
          gösteriliyor.
        </p>
        <div className="mt-4 rounded-[var(--radius)] border border-[var(--notice-line)] bg-[var(--notice-soft)] px-3.5 py-3 text-left text-sm text-[var(--notice)]">
          <p className="font-semibold">Fiyatlar güncellenmiyor</p>
          <p className="mt-1">
            Bağlantı yokken canlı fiyat akışı çalışmaz. Gördüğünüz değerler güncel değildir.
          </p>
        </div>
        <p className="mt-4 text-sm text-muted">
          Bağlantınız geri geldiğinde sayfayı yenileyin.
        </p>
      </div>
    </main>
  );
}
