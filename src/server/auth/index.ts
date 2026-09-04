import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { cookies, headers } from "next/headers";

import type { UserProfile } from "@/auth/types";
import { AdminService } from "@/server/admin/admin-service";
import { PortfolioHistoryService } from "@/server/portfolio/portfolio-history-service";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { getLoginRateLimiter } from "@/server/rate-limit";
import { resolveAuthBackendId, serverEnv } from "@/server/env";
import { resolveClientIp } from "@/server/security/client-ip";
import type { AdminActor, UserActor } from "./actor";
import type { AuthBackend } from "./backend";
import { sessionCookieOptions } from "./cookies";
import { LocalAuthBackend } from "./local-backend";
import { AuthService, type SessionContext } from "./service";
import { MfaService } from "./mfa-service";
import { PriceIngestionService } from "@/server/prices/ingestion-service";
import { PriceSourceService } from "@/server/prices/price-source-service";
import { SupabaseAuthBackend } from "./supabase-backend";

export { AuthService } from "./service";
export { MfaService } from "./mfa-service";
export * from "./errors";
export { sessionCookieOptions } from "./cookies";
export type { AdminActor, UserActor } from "./actor";

/**
 * Sunucu tarafı kimlik doğrulama giriş noktası.
 *
 * GUARD'LAR
 * - requireAuthenticatedUser: oturum yeter. Geçici parolalı kullanıcı da geçer.
 *   YALNIZCA /api/auth/session, /logout, /logout-all ve /change-password bunu kullanır.
 * - requireUsableUser: geçici parolalı kullanıcı GEÇEMEZ (PASSWORD_CHANGE_REQUIRED).
 * - requireCurrentAdmin: ek olarak veritabanındaki rolü admin olmalı.
 *
 * İSTEK KAPSAMLI OTURUM ÖNBELLEĞİ
 * apiRoute() her isteği `runWithSessionCache` içinde çalıştırır; aynı istekte
 * oturum bir kez çözülür. İstek sonunda `commitSessionCookie` süre uzatma
 * veya kimlik yenileme olduysa çerezi tazeler (bkz. security/route.ts).
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

let historyServiceInstance: PortfolioHistoryService | null = null;

export function getPortfolioHistoryService(): PortfolioHistoryService {
  if (!historyServiceInstance) {
    historyServiceInstance = new PortfolioHistoryService(getAuthBackend());
  }
  return historyServiceInstance;
}

export const SESSION_COOKIE = serverEnv.sessionCookieName;

// ------------------------------------------------- istek kapsamlı oturum önbelleği

interface SessionCache {
  resolved: boolean;
  token: string | null;
  session: SessionContext | null;
  /** Çıkış yapıldıysa istek sonunda çerez ASLA yeniden yazılmaz. */
  ended: boolean;
}

const sessionCacheStorage = new AsyncLocalStorage<SessionCache>();

/** apiRoute tarafından kullanılır: isteği oturum önbelleğiyle çalıştırır. */
export function runWithSessionCache<T>(fn: () => Promise<T>): Promise<T> {
  return sessionCacheStorage.run({ resolved: false, token: null, session: null, ended: false }, fn);
}

/** Çıkış uçları çağırır: bu istekte çerez yeniden yazılmaz. */
export function markSessionEnded(): void {
  const cache = sessionCacheStorage.getStore();
  if (cache) {
    cache.ended = true;
    cache.session = null;
  }
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function getSessionContext(): Promise<SessionContext | null> {
  const cache = sessionCacheStorage.getStore();
  if (cache?.resolved) return cache.session;

  const token = await readSessionToken();
  const session = await getAuthService().resolveSessionContext(token);
  if (cache) {
    cache.resolved = true;
    cache.token = token;
    cache.session = session;
  }
  return session;
}

/**
 * İstek sonunda: süre uzatıldıysa veya kimlik yenileme zamanı geldiyse oturum
 * çerezini tazeler. Kullanıcı bunu fark etmez. Yalnızca route handler'larda
 * (çerez yazılabilen bağlamda) çağrılır.
 */
export async function commitSessionCookie(): Promise<void> {
  const cache = sessionCacheStorage.getStore();
  if (!cache?.resolved || cache.ended || !cache.session || !cache.token) return;

  // Tarayıcı oturumu / admin: çerez kalıcı değildir, yenileme yoktur; tazelenecek bir şey yok.
  if (!cache.session.persistent) return;

  const rotatedToken = await getAuthService().rotateSessionIfDue(cache.session);
  if (!rotatedToken && !cache.session.renewed) return;

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    rotatedToken ?? cache.token,
    sessionCookieOptions(cache.session.expiresAt, await isSecureRequest(), true),
  );
}

export async function getCurrentUser(): Promise<UserProfile | null> {
  return (await getSessionContext())?.profile ?? null;
}

/** Oturum yeter; geçici parolalı kullanıcı da geçer. */
export async function requireAuthenticatedUser(): Promise<UserActor> {
  return getAuthService().userActorFrom(await getSessionContext());
}

/** Geçici parolalı kullanıcı PASSWORD_CHANGE_REQUIRED ile reddedilir. */
export async function requireUsableUser(): Promise<UserActor> {
  return getAuthService().usableActorFrom(await getSessionContext());
}

export async function requireCurrentAdmin(): Promise<AdminActor> {
  return getAuthService().adminActorWithMfa(await getSessionContext());
}

/** Yalnızca ikinci faktör kurulum/doğrulama uçları için (MFA henüz yok). */
export async function requireAdminForMfaSetup(): Promise<AdminActor> {
  return getAuthService().adminActorFrom(await getSessionContext());
}

export function getMfaService(): MfaService {
  return new MfaService(getAuthBackend());
}

export function getPriceSourceService(): PriceSourceService {
  return new PriceSourceService(getAuthBackend());
}

export function getPriceIngestionService(): PriceIngestionService {
  return new PriceIngestionService(getAuthBackend());
}

/**
 * Hız sınırlaması için istemci anahtarı.
 * X-Forwarded-For yalnızca güvenilir vekil sağlayıcısında dikkate alınır;
 * aksi hâlde saldırganın belirlediği başlık YOK SAYILIR (bkz. client-ip.ts).
 * Ham IP hiçbir yere yazılmaz; sınırlayıcı anahtarı HMAC ile gizler.
 */
export async function clientKey(): Promise<string> {
  return resolveClientIp(await headers(), serverEnv.trustedProxyProvider);
}

/** İstek HTTPS üzerinden mi geliyor? Ters vekil arkasında başlıktan okunur. */
export async function isSecureRequest(): Promise<boolean> {
  if (serverEnv.isProduction) return true;
  const headerList = await headers();
  return (headerList.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
}
