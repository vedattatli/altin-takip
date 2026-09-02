import "server-only";

import { NextResponse } from "next/server";

import { AppError } from "./auth/errors";

/** Tüm API yanıtları aynı zarfı kullanır: { data } veya { error }. */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function failure(error: unknown): NextResponse {
  if (error instanceof AppError) {
    const headers: Record<string, string> = {};
    if (error.retryAfterMs > 0) {
      headers["Retry-After"] = String(Math.ceil(error.retryAfterMs / 1000));
    }
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers },
    );
  }

  // Beklenmeyen hataların iç detayı istemciye sızdırılmaz.
  console.error("[api]", error);
  return NextResponse.json(
    { error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.", code: "internal" },
    { status: 500 },
  );
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError(400, "İstek gövdesi okunamadı.", "bad_request");
  }
}
