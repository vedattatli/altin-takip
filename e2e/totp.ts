import { createDecipheriv, createHmac } from "node:crypto";

/**
 * Test tarafı TOTP üreteci (RFC 6238).
 *
 * Uygulama kodundaki `src/server/auth/totp.ts` "server-only" işaretlidir ve
 * Playwright'ın Node çalışma zamanından içe aktarılamaz. Bu dosya AYNI algoritmayı
 * bağımsız uygular; şifreleme anahtarına veya sunucu istemcisine DOKUNMAZ.
 * Uygulama tarafındaki üreteçle bit birebir uyum `tests/price-sources.test.ts`
 * (bölüm 5) içinde doğrulanır.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Geçersiz base32 karakteri");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, atMs: number, stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Depodaki şifreli TOTP anahtarını çözer (AES-256-GCM).
 *
 * Uygulamadaki `decryptSecret` ile aynı biçimi kullanır ama server-only modüle
 * bağlı değildir. YALNIZCA test içindir: anahtar Playwright yapılandırmasındaki
 * sabit test değeridir, gerçek bir secret değildir.
 */
export function decryptStoredSecret(ciphertext: string, nonce: string, encryptionKey?: string): string {
  // Playwright çalıştırıcısı webServer.env'i kendi sürecine yazmadığı için anahtar
  // açıkça geçilir; ortam değişkeni yalnızca yedek yoldur.
  const raw = (encryptionKey ?? process.env.AUTH_MFA_ENCRYPTION_KEY ?? "").trim();
  if (raw === "") throw new Error("AUTH_MFA_ENCRYPTION_KEY tanımlı değil.");
  const key = /^[0-9a-f]{64}$/iu.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  const payload = Buffer.from(ciphertext, "base64");
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
