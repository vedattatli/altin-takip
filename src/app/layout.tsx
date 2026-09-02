import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { appConfig } from "@/config/app.config";
import { HydrationMarker } from "@/components/hydration-marker";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${appConfig.name} — ${appConfig.tagline}`,
    template: `%s · ${appConfig.name}`,
  },
  description: appConfig.description,
  applicationName: appConfig.name,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: appConfig.shortName,
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Uygulama koyu temadır; tarayıcı arayüzü de aynı rengi kullanır.
  themeColor: "#0d1014",
};

/**
 * Kök yerleşim bilinçli olarak oturum veya çerez OKUMAZ.
 *
 * Böylece çevrimdışı sayfası ve 404 gibi statik sayfalar Supabase yapılandırması
 * olmadan da derlenebilir. Servis çalışanı kaydı oturumu zaten çözen alt
 * yerleşimde yapılır.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr" className="h-full">
      <body className="flex min-h-full flex-col">
        <a className="skip-link" href="#icerik">
          İçeriğe atla
        </a>
        {children}
        <HydrationMarker />
      </body>
    </html>
  );
}
