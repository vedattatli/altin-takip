import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * İçerik Güvenliği Politikası.
 *
 * Next.js çalışma biçimini bozmayacak biçimde yazılmıştır:
 * - Next, hidrasyon için satır içi bootstrap script'leri üretir; nonce
 *   altyapısı kurulmadığı sürece script-src 'unsafe-inline' gereklidir.
 * - Geliştirme sunucusu ayrıca 'unsafe-eval' ve websocket bağlantısı ister.
 * - frame-ancestors 'none' ile clickjacking engellenir (X-Frame-Options'ın
 *   modern karşılığı).
 * - Dış kaynak yoktur: default-src, connect-src ve img-src kendi origin'imizle sınırlıdır.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  isProduction ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    // Uygulama hiçbir cihaz iznine ihtiyaç duymaz; hepsi kapatılır.
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HSTS YALNIZCA üretimde (HTTPS) gönderilir; yerel http geliştirmeyi bozmaz.
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
