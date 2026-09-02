import "server-only";

import { cookies, headers } from "next/headers";

import type { UserProfile } from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { getLoginRateLimiter } from "@/server/rate-limit";
import { resolveAuthBackendId, serverEnv } from "@/server/env";
import type { AdminActor, UserActor } from "./actor";
import type { AuthBackend, ResolvedSession } from "./backend";
import { LocalAuthBackend } from "./local-backend";
import { AuthService } from "./service";
import { SupabaseAuthBackend } from "./supabase-backend";

export { AuthService } from "./service";
export * from "./errors";
export { sessionCookieOptions } from "./cookies";
export type { AdminActor, UserActor } from "./actor";

/**
 * Sunucu tarafı kimlik doğrulama giriş noktası.
 *
 * GUARD'LAR
 * - requireAuthenticatedUser: oturum yeter. Geçici parolalı kullanıcı da geçer.
 *   YALNIZCA /api/auth/session, /logout ve /change-password bunu kullanır.
 * - requireUsableUser: geçici parolalı kullanıcı GEÇEMEZ (PASSWORD_CHANGE_REQUIRED).
 * - requireCurrentAdmin: ek olarak veritabanındaki rolü admin olmalı.
 */

let backendInstance: AuthBackend | null = null;
let serviceInstance: AuthService | null = null;
let adminServiceInstance: AdminService | null = null;
let portfolioServiceInstance: UserPortfolioService | null = null;

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
      rateLimiter: getLoginRateLimiter(),
    });
  }
  return serviceInstance;
}

export function getAdminService(): AdminService {
  if (!adminServiceInstance) adminServiceInstance = new AdminService(getAuthBackend());
  return adminServiceInstance;
}

export function getUserPortfolioService(): UserPortfolioService {
  if (!portfolioServiceInstance) {
    portfolioServiceInstance = new UserPortfolioService(getAuthBackend());
  }
  return portfolioServiceInstance;
}

export const SESSION_COOKIE = serverEnv.sessionCookieName;

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function getSessionContext(): Promise<ResolvedSession | null> {
  return getAuthService().resolveSessionContext(await readSessionToken());
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  return getAuthService().resolveSession(await readSessionToken());
}

/** Oturum yeter; geçici parolalı kullanıcı da geçer. */
export async function requireAuthenticatedUser(): Promise<UserActor> {
  return getAuthService().requireAuthenticatedUser(await readSessionToken());
}

/** Geçici parolalı kullanıcı PASSWORD_CHANGE_REQUIRED ile reddedilir. */
export async function requireUsableUser(): Promise<UserActor> {
  return getAuthService().requireUsableUser(await readSessionToken());
}

export async function requireCurrentAdmin(): Promise<AdminActor> {
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
