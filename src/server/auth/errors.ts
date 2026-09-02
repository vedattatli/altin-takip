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

/**
 * Geçici parolalı kullanıcı, parolasını değiştirene kadar hiçbir korumalı
 * ucu kullanamaz. İstemci bu kodu görünce parola değiştirme ekranına gider.
 */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

export function unauthorized(message = "Bu işlem için giriş yapmanız gerekiyor."): AppError {
  return new AppError(401, message, "unauthorized");
}

export function forbidden(message = "Bu işlem için yetkiniz yok."): AppError {
  return new AppError(403, message, "forbidden");
}

export function passwordChangeRequired(): AppError {
  return new AppError(
    403,
    "Devam etmek için parolanızı değiştirmeniz gerekiyor.",
    PASSWORD_CHANGE_REQUIRED,
  );
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

/**
 * Kullanıcının portföyü provisioning ile oluşturulmamış. GET yolları veri
 * OLUŞTURMAZ; bu durum yönetici onarımı (provision_missing_defaults) ister.
 */
export function portfolioNotProvisioned(): AppError {
  return new AppError(
    500,
    "Portföy kaydınız hazırlanmamış. Lütfen sistem yöneticinizle iletişime geçin.",
    "portfolio_not_provisioned",
  );
}

/** Origin / CSRF doğrulaması başarısız. */
export function csrfRejected(message = "İstek doğrulanamadı. Sayfayı yenileyip tekrar deneyin."): AppError {
  return new AppError(403, message, "csrf_rejected");
}

/** Yapılandırma hatası — güvenlik bileşeni eksikse sessizce zayıf moda düşülmez. */
export function misconfigured(message: string): AppError {
  return new AppError(500, message, "misconfigured");
}
