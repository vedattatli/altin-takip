/**
 * İstemci tarafı API çağrıları.
 *
 * Durum değiştiren her istek, sayfadaki <meta name="csrf-token"> değerini
 * X-CSRF-Token başlığında gönderir. Jeton localStorage/sessionStorage'a
 * YAZILMAZ; sunucudaki eşi HttpOnly çerezdedir.
 */

const CSRF_HEADER = "X-CSRF-Token";

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

export interface ApiEnvelope<T> {
  data?: T;
  error?: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Sunucunun "parola değiştirmelisin" yanıtı. */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    headers.set(CSRF_HEADER, csrfToken());
  }

  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? "İstek başarısız oldu. Lütfen tekrar deneyin.",
      payload?.code ?? "error",
    );
  }
  return (payload?.data ?? null) as T;
}
