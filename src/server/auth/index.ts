import "server-only";

import { cookies, headers } from "next/headers";

import { LoginRateLimiter } from "@/auth/rate-limit";
import type { DeviceMode, UserProfile } from "@/auth/types";
import { resolveAuthBackendId, serverEnv } from "@/server/env";
import type { AuthBackend } from "./backend";
import { LocalAuthBackend } from "./local-backend";
import { AuthService } from "./service";
import { SupabaseAuthBackend } from "./supabase-backend";

export { AuthService } from "./service";
export * from "./errors";
export { sessionCookieOptions } from "./cookies";

/**
 * Sunucu tarafı kimlik doğrulama giriş noktası.
 *
 * Arka uç seçimi tek yerden yapılır. Hız sınırlayıcı süreç boyunca
 * paylaşılır ki farklı isteklerdeki denemeler aynı sayaçta toplansın.
 */

let backendInstance: AuthBackend | null = null;
let serviceInstance: AuthService | null = null;
const rateLimiter = new LoginRateLimiter();

function createBackend(): AuthBackend {
  const id = resolveAuthBackendId();
  if (id === "local") return new LocalAuthBackend();
  return new SupabaseAuthBackend();
}

export function getAuthBackend(): AuthBackend {
  if (!backendInstance) backendInstance = createBackend();
  return backendInstance;
}

export function getAuthService(): AuthService {
  if (!serviceInstance) {
    serviceInstance = new AuthService(getAuthBackend(), {
      rateLimiter,
      sessionTtlMs: Math.max(1, serverEnv.sessionTtlHours) * 60 * 60 * 1000,
    });
  }
  return serviceInstance;
}

export const SESSION_COOKIE = serverEnv.sessionCookieName;

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  return getAuthService().resolveSession(await readSessionToken());
}

/** Oturum + oturumun açıldığı cihaz türü. Arayüz kısıtları buna göre uygulanır. */
export async function getSessionContext(): Promise<{
  profile: UserProfile;
  deviceMode: DeviceMode;
} | null> {
  return getAuthService().resolveSessionContext(await readSessionToken());
}

export async function requireCurrentUser(): Promise<UserProfile> {
  return getAuthService().requireUser(await readSessionToken());
}

export async function requireCurrentAdmin(): Promise<UserProfile> {
  return getAuthService().requireAdmin(await readSessionToken());
}

/** Hız sınırlaması için istemci anahtarı. Proxy arkasında X-Forwarded-For kullanılır. */
export async function clientKey(): Promise<string> {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headerList.get("x-real-ip") ?? "unknown";
}

/** İstek HTTPS üzerinden mi geliyor? Ters vekil arkasında başlıktan okunur. */
export async function isSecureRequest(): Promise<boolean> {
  if (serverEnv.isProduction) return true;
  const headerList = await headers();
  return (headerList.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}
