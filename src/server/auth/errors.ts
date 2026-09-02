/** Uygulama genelinde tek tip hata: HTTP kodu + kullanıcıya gösterilebilir Türkçe mesaj. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "error",
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Giriş hatalarında kullanıcı/parola ayrımı YAPILMAZ (hesap keşfini engellemek için). */
export const GENERIC_LOGIN_ERROR = "Kullanıcı adı veya parola hatalı.";

export function unauthorized(message = "Bu işlem için giriş yapmanız gerekiyor."): AppError {
  return new AppError(401, message, "unauthorized");
}

export function forbidden(message = "Bu işlem için yetkiniz yok."): AppError {
  return new AppError(403, message, "forbidden");
}

export function notFound(message = "Kayıt bulunamadı."): AppError {
  return new AppError(404, message, "not_found");
}

export function badRequest(message: string): AppError {
  return new AppError(400, message, "bad_request");
}

export function conflict(message: string): AppError {
  return new AppError(409, message, "conflict");
}

export function tooManyRequests(message: string, retryAfterMs: number): AppError {
  return new AppError(429, message, "rate_limited", retryAfterMs);
}
