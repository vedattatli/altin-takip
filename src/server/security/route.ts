import "server-only";

import type { NextResponse } from "next/server";

import { csrfRejected, misconfigured } from "@/server/auth/errors";
import { serverEnv } from "@/server/env";
import { failure } from "@/server/http";
import { csrfSecretOrNull } from "./config";
import { checkOrigin, CSRF_HEADER, STATE_CHANGING_METHODS, verifyCsrf } from "./csrf";
import { expectedOrigins } from "./origins";

/**
 * Tüm API uçları için merkezi koruma.
 *
 * Durum değiştiren her istek (POST/PUT/PATCH/DELETE) şu iki kontrolden geçer:
 *  1. Origin + Sec-Fetch-Site: istek uygulamanın kendi origin'inden gelmeli.
 *  2. İmzalı CSRF jetonu: X-CSRF-Token başlığı HttpOnly çerezdeki imzalı
 *     jetonla eşleşmeli.
 *
 * Bir route'un bu kontrolü unutmasını engellemek için TÜM route'lar bu
 * sarmalayıcıyı kullanır; `tests/security-surface.test.ts` bunu denetler.
 */

export function csrfSecret(): string {
  const secret = csrfSecretOrNull();
  if (!secret) {
    throw misconfigured(
      "AUTH_CSRF_SECRET tanımlı değil. Üretimde CSRF koruması olmadan çalıştırılamaz.",
    );
  }
  return secret;
}

/** Durum değiştiren istekleri doğrular; geçersizse AppError fırlatır. */
export async function assertRequestIsSafe(request: Request): Promise<void> {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return;

  const origins = expectedOrigins(request.headers, serverEnv.appOrigin);
  const originCheck = checkOrigin(request.headers, origins);
  if (!originCheck.ok) {
    throw csrfRejected("İstek beklenen adresten gelmedi ve reddedildi.");
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieValue = readCookie(cookieHeader, serverEnv.csrfCookieName);
  const headerValue = request.headers.get(CSRF_HEADER);

  const valid = await verifyCsrf(cookieValue, headerValue, csrfSecret());
  if (!valid) {
    throw csrfRejected();
  }
}

/** Ham Cookie başlığından tek bir çerezi okur. */
export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

type RouteHandler<Context> = (request: Request, context: Context) => Promise<NextResponse>;

/**
 * API route sarmalayıcısı: güvenlik kontrolü + tek tip hata dönüşümü.
 * Her route dosyası bu sarmalayıcıyı kullanmak ZORUNDADIR.
 */
export function apiRoute<Context = unknown>(handler: RouteHandler<Context>): RouteHandler<Context> {
  return async (request: Request, context: Context) => {
    try {
      await assertRequestIsSafe(request);
      return await handler(request, context);
    } catch (error) {
      return failure(error);
    }
  };
}
