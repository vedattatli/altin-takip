import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — yönetici ikinci faktörü.
 *
 * - Secret veritabanında DÜZ METİN tutulmaz: AES-256-GCM ile şifrelenir.
 *   Anahtar `AUTH_MFA_ENCRYPTION_KEY` ortam değişkeninden gelir (base64 veya hex, 32 bayt).
 * - Kurtarma kodları yalnızca SHA-256 özetiyle saklanır; tek kullanımlıktır.
 * - Secret ve kodlar loglanmaz; yalnızca kayıt (enrollment) anında bir kez gösterilir.
 * - Kod karşılaştırması sabit zamanlıdır.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Saat kaymasına tolerans: bir önceki ve bir sonraki pencere kabul edilir. */
export const TOTP_WINDOW = 1;

export function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Yeni TOTP secret üretir (base32, 160 bit). */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

function counterBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(Math.floor(counter)));
  return buffer;
}

/** Belirli bir zaman penceresi için TOTP kodu üretir. */
export function totpCode(secretBase32: string, timestampMs: number, period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS): string {
  const counter = Math.floor(timestampMs / 1000 / period);
  const hmac = createHmac("sha1", decodeBase32(secretBase32)).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Bir kodun hangi zaman adımıyla eşleştiği. */
export interface TotpMatch {
  ok: boolean;
  /** Eşleşen zaman adımı (time-step counter). Replay koruması bunu saklar. */
  counter: number | null;
}

/**
 * Kodu doğrular (±1 pencere) ve EŞLEŞEN SAYACI döndürür.
 *
 * Sayaç boolean yerine döndürülür çünkü aynı kod 30 saniyelik pencere içinde
 * ikinci bir oturumda tekrar kullanılamamalıdır: çağıran taraf bu sayacı kalıcı
 * olarak saklar ve aynı ya da daha eski sayacı reddeder.
 *
 * Karşılaştırma sabit zamanlıdır ve bütün pencereler her koşulda denenir (erken
 * çıkış yoktur), böylece hangi pencerenin tuttuğu zamanlamadan sızmaz.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  timestampMs: number,
  options: { period?: number; digits?: number; window?: number } = {},
): TotpMatch {
  const period = options.period ?? TOTP_PERIOD_SECONDS;
  const digits = options.digits ?? TOTP_DIGITS;
  const window = options.window ?? TOTP_WINDOW;
  const clean = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false, counter: null };
  const candidate = Buffer.from(clean, "utf8");
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const at = timestampMs + offset * period * 1000;
    const expected = Buffer.from(totpCode(secretBase32, at, period, digits), "utf8");
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      matched = Math.floor(at / 1000 / period);
    }
  }
  return { ok: matched !== null, counter: matched };
}

/** Verilen anın TOTP zaman adımı. */
export function totpCounter(timestampMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(timestampMs / 1000 / period);
}

/** Kimlik doğrulayıcı uygulamalar için otpauth URI'si (yalnızca kayıt anında gösterilir). */
export function otpauthUri(secretBase32: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ------------------------------------------------------------------ şifreleme

function encryptionKey(): Buffer {
  const raw = (process.env.AUTH_MFA_ENCRYPTION_KEY ?? "").trim();
  if (raw === "") {
    throw new Error(
      "AUTH_MFA_ENCRYPTION_KEY tanımlı değil. Yönetici ikinci faktörü bu anahtar olmadan kullanılamaz.",
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("AUTH_MFA_ENCRYPTION_KEY 32 baytlık (256 bit) bir anahtar olmalıdır.");
  }
  return key;
}

export function hasMfaEncryptionKey(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
}

/** Secret'ı AES-256-GCM ile şifreler. Sonuç: base64 ciphertext(+tag) ve nonce. */
export function encryptSecret(secret: string): EncryptedSecret {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

export function decryptSecret(encrypted: EncryptedSecret): string {
  const key = encryptionKey();
  const payload = Buffer.from(encrypted.ciphertext, "base64");
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// -------------------------------------------------------------- kurtarma kodu

export const RECOVERY_CODE_COUNT = 10;

/** Okunabilir, karışmayan kurtarma kodu (örn. "K7F2-9QMX-3TDB"). */
export function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => generateRecoveryCode());
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
