import type { TrustedProxyProvider } from "@/server/env";

/**
 * İstemci IP çözümlemesi — yalnızca hız sınırlaması anahtarı için.
 *
 * X-Forwarded-For / X-Real-IP başlıkları istemci tarafından SERBESTÇE
 * yazılabilir. Bu başlıklara yalnızca istekleri gerçekten bir güvenilir ters
 * vekilin (Vercel) sonlandırdığı biliniyorsa güvenilir. Sağlayıcı "none" veya
 * bilinmiyorsa başlıklar YOK SAYILIR; saldırgan başlıkla kendine yeni IP
 * uyduramaz ve hız sınırını atlatamaz.
 *
 * Dönen değer hiçbir yere ham hâliyle yazılmaz; sınırlayıcı katmanı anahtarı
 * peppered HMAC ile gizleyerek saklar (bkz. rate-limit/key.ts).
 */
export function resolveClientIp(
  headers: { get(name: string): string | null },
  provider: TrustedProxyProvider,
): string {
  switch (provider) {
    case "vercel": {
      // Vercel, x-real-ip'i kendisi yazar ve istemci değerini ezer;
      // x-forwarded-for'un ilk elemanı da Vercel tarafından eklenir.
      const real = clean(headers.get("x-real-ip"));
      if (real) return real;
      return firstForwarded(headers) ?? "direct";
    }
    case "local":
      // Yerel geliştirme / test: `next dev` veya `next start` doğrudan dinler.
      return firstForwarded(headers) ?? clean(headers.get("x-real-ip")) ?? "local";
    case "none":
    default:
      // Güvenilir vekil yok: başlıklar yok sayılır. Tüm doğrudan istekler
      // tek IP kovası paylaşır; kullanıcı adı ve kombinasyon kovaları ayrımı sürdürür.
      return "direct";
  }
}

function firstForwarded(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return null;
  return clean(raw.split(",")[0]);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.length > 64) return null;
  return trimmed;
}
