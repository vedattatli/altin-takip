import "server-only";

import { NextResponse } from "next/server";

import { failure } from "@/server/http";
import { timingSafeEqualString } from "./csrf";

/**
 * MAKİNE UÇLARI (zamanlanmış görevler)
 *
 * Tarayıcı uçlarından AYRI bir sarmalayıcıdır. Neden gerekli:
 *
 *  - `apiRoute` her POST'ta Origin + Sec-Fetch-Site + imzalı CSRF çerezi ister.
 *    Bunlar YALNIZCA tarayıcıda vardır. Bir cron zamanlayıcısının elinde çerez,
 *    sayfa meta jetonu veya kullanıcı oturumu yoktur; doğru secret'ı gönderse
 *    bile istek secret kontrolüne ulaşmadan CSRF aşamasında reddedilirdi.
 *  - Bu sarmalayıcı oturum ÇÖZMEZ, çerez YAZMAZ, oturum ömrü UZATMAZ.
 *    Dolayısıyla makine çağrısı hiçbir kullanıcı oturumunu etkilemez.
 *
 * Güvenlik modeli tek bir şeye dayanır: paylaşılan secret.
 *  - Yalnızca `Authorization: Bearer <secret>` veya `X-Cron-Secret` kabul edilir.
 *  - Karşılaştırma sabit sürelidir.
 *  - Secret tanımlı değilse uç KAPALIDIR (fail closed).
 *  - Origin, Referer veya çereze ASLA güvenilmez.
 *
 * Normal mutation uçlarının CSRF koruması bu dosyadan etkilenmez.
 */

const HEADERS = { "Cache-Control": "private, no-store" } as const;

/** Zamanlanmış çağrının kimliği: aynı dakika = aynı koşum. */
export interface MachineRequestContext {
  /**
   * Sunucu tarafından üretilen deterministik koşum anahtarı.
   *
   * Aynı dakika içinde tekrarlanan cron çağrısı AYNI anahtarı üretir; ingestion
   * idempotent olduğu için ikinci çağrı yeni fiyat geçmişi satırı oluşturmaz.
   * İstemciden gelen hiçbir değer bu anahtara karışmaz.
   */
  runKey: string;
  /** Anahtarın türetildiği dakika (ISO, saniye alanı sıfırlanmış). */
  minuteIso: string;
}

/** Verilen zamanı dakikaya yuvarlayarak deterministik koşum anahtarı üretir. */
export function machineRunKey(prefix: string, now: number): { runKey: string; minuteIso: string } {
  const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  return { runKey: `${prefix}:${minute}`, minuteIso: minute };
}

/** İsteğin paylaşılan secret'ı taşıyıp taşımadığını sabit sürede doğrular. */
export function machineAuthorized(request: Request, secretValue: string | undefined): boolean {
  const secret = (secretValue ?? "").trim();
  // Secret tanımsızsa uç kapalıdır: boş secret ile "herkes geçer" durumu oluşmaz.
  if (secret === "") return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const custom = (request.headers.get("x-cron-secret") ?? "").trim();
  return timingSafeEqualString(bearer, secret) || timingSafeEqualString(custom, secret);
}

type MachineHandler<Context> = (
  request: Request,
  context: Context,
  machine: MachineRequestContext,
) => Promise<NextResponse>;

export interface MachineRouteOptions {
  /** Secret'ı okuyacak ortam değişkeninin ADI (değeri asla loglanmaz). */
  secretEnv: string;
  /** Koşum anahtarı öneki (ör. "price-ingestion"). */
  runKeyPrefix: string;
  /** Testler için sabit saat. */
  now?: () => number;
}

/**
 * Zamanlanmış görev sarmalayıcısı.
 *
 * `apiRoute` YERİNE kullanılır; tarayıcı oturumu ve CSRF beklemez, çerez yazmaz.
 */
export function machineRoute<Context = unknown>(
  options: MachineRouteOptions,
  handler: MachineHandler<Context>,
): (request: Request, context: Context) => Promise<NextResponse> {
  return async (request: Request, context: Context) => {
    try {
      if (!machineAuthorized(request, process.env[options.secretEnv])) {
        // Mesaj secret'ın var olup olmadığını, uzunluğunu veya adresini sızdırmaz.
        return NextResponse.json(
          { error: "Bu uç yalnızca zamanlanmış görev tarafından çağrılabilir.", code: "forbidden" },
          { status: 403, headers: HEADERS },
        );
      }
      const machine = machineRunKey(options.runKeyPrefix, options.now?.() ?? Date.now());
      const response = await handler(request, context, machine);
      // Makine yanıtı hiçbir koşulda çerez taşımaz.
      response.headers.delete("set-cookie");
      response.headers.set("Cache-Control", HEADERS["Cache-Control"]);
      return response;
    } catch (error) {
      return failure(error);
    }
  };
}
