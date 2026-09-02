/**
 * Parola politikası.
 *
 * Bu dosya YALNIZCA politika kontrolü yapar. Parola saklamaz, hash'lemez.
 * Parola saklama ve doğrulama işi kimlik sağlayıcısına (Supabase Auth) aittir.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES_TR = [
  `En az ${PASSWORD_MIN_LENGTH} karakter olmalı.`,
  "En az bir harf ve bir rakam içermeli.",
  "Yaygın ve kolay tahmin edilen parolalar kabul edilmez.",
  "Kullanıcı adını içeremez.",
];

/** Sık kullanılan / sızıntılarda öne çıkan parolalar. Küçük harfe indirgenmiş hâlleriyle. */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd123",
  "123456789",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty12345",
  "administrator",
  "admin12345",
  "adminadmin",
  "welcome123",
  "letmein123",
  "iloveyou123",
  "sifre12345",
  "parola12345",
  "sifrem12345",
  "altintakip",
  "altintakip1",
  "altintakip123",
  "turkiye123",
  "istanbul123",
  "ankara12345",
  "galatasaray",
  "fenerbahce1",
  "besiktas123",
  "trabzonspor",
  "abcdefghij",
  "aaaaaaaaaa",
  "1111111111",
]);

const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl"];

export interface PasswordValidation {
  ok: boolean;
  error: string | null;
}

function hasLongSequence(lower: string): boolean {
  for (const sequence of SEQUENCES) {
    for (let index = 0; index + 6 <= sequence.length; index += 1) {
      const run = sequence.slice(index, index + 6);
      if (lower.includes(run)) return true;
      if (lower.includes(Array.from(run).reverse().join(""))) return true;
    }
  }
  return false;
}

export function validatePassword(password: string, username?: string): PasswordValidation {
  const fail = (error: string): PasswordValidation => ({ ok: false, error });

  if (typeof password !== "string" || password.length === 0) {
    return fail("Parola boş olamaz.");
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return fail(`Parola en az ${PASSWORD_MIN_LENGTH} karakter olmalıdır.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return fail(`Parola en fazla ${PASSWORD_MAX_LENGTH} karakter olabilir.`);
  }
  if (password.trim().length !== password.length) {
    return fail("Parola boşlukla başlayamaz veya bitemez.");
  }

  const lower = password.toLowerCase();

  if (!/[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(password)) {
    return fail("Parola en az bir harf içermelidir.");
  }
  if (!/[0-9]/.test(password)) {
    return fail("Parola en az bir rakam içermelidir.");
  }
  if (COMMON_PASSWORDS.has(lower)) {
    return fail("Bu parola çok yaygın kullanılıyor. Lütfen daha güçlü bir parola seçin.");
  }
  if (/^(.)\1+$/.test(password)) {
    return fail("Parola tek bir karakterin tekrarından oluşamaz.");
  }
  if (hasLongSequence(lower)) {
    return fail("Parola ardışık karakter dizisi içeremez (örn. 123456, abcdef).");
  }
  if (username) {
    const normalized = username.toLowerCase();
    if (normalized.length >= 3 && lower.includes(normalized)) {
      return fail("Parola kullanıcı adınızı içeremez.");
    }
  }

  return { ok: true, error: null };
}

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * Admin panelinde ve CLI'da önerilecek geçici parola üretir.
 * Kriptografik olarak güvenli kaynak kullanır.
 */
export function generateTemporaryPassword(length = 14): string {
  const size = Math.max(PASSWORD_MIN_LENGTH, length);
  const bytes = new Uint32Array(size);
  globalThis.crypto.getRandomValues(bytes);

  let password = "";
  for (let index = 0; index < size; index += 1) {
    password += TEMP_ALPHABET[bytes[index] % TEMP_ALPHABET.length];
  }

  // Politika gereği en az bir harf ve bir rakam garanti edilir.
  if (!/[0-9]/.test(password)) password = `${password.slice(0, -1)}7`;
  if (!/[a-zA-Z]/.test(password)) password = `k${password.slice(1)}`;
  return password;
}
