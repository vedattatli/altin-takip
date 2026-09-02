import { describe, expect, it } from "vitest";

import {
  generateTemporaryPassword,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from "@/auth/password";
import { formatRetryAfter, LoginRateLimiter } from "@/auth/rate-limit";

describe("parola politikası", () => {
  it("güçlü parolayı kabul eder", () => {
    expect(validatePassword("Kuyumcu7Defter", "ayse").ok).toBe(true);
  });

  it("10 karakterden kısa parolayı reddeder", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    const result = validatePassword("Kisa12345");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/en az 10 karakter/);
  });

  it("rakamsız parolayı reddeder", () => {
    expect(validatePassword("sadeceharfler").error).toMatch(/rakam/);
  });

  it("harfsiz parolayı reddeder", () => {
    expect(validatePassword("99887766554433").error).toMatch(/harf/);
  });

  it("yaygın parolaları reddeder", () => {
    for (const password of ["password123", "qwerty12345", "altintakip123", "1234567890"]) {
      expect(validatePassword(password).ok, `${password} reddedilmeli`).toBe(false);
    }
  });

  it("ardışık karakter dizisi içeren parolayı reddeder", () => {
    expect(validatePassword("abcdef9posta").error).toMatch(/ardışık/);
    expect(validatePassword("xy123456posta").error).toMatch(/ardışık/);
  });

  it("kullanıcı adını içeren parolayı reddeder", () => {
    const result = validatePassword("mehmet7yildiz", "mehmet");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/kullanıcı adınızı/);
  });

  it("tek karakterin tekrarını reddeder", () => {
    expect(validatePassword("aaaaaaaaaaaa").ok).toBe(false);
  });

  it("boşlukla başlayan veya biten parolayı reddeder", () => {
    expect(validatePassword(" Kuyumcu7Defter").error).toMatch(/boşlukla/);
  });

  it("çok uzun parolayı reddeder", () => {
    expect(validatePassword(`A1${"x".repeat(200)}`).ok).toBe(false);
  });

  it("üretilen geçici parola politikaya uyar", () => {
    for (let index = 0; index < 40; index += 1) {
      const password = generateTemporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(validatePassword(password).ok, `${password} politikaya uymalı`).toBe(true);
    }
  });

  it("üretilen parolalar birbirinden farklıdır", () => {
    const generated = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()));
    expect(generated.size).toBe(20);
  });
});

describe("giriş hız sınırlayıcı", () => {
  function limiter(now: () => number) {
    return new LoginRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      baseLockMs: 30_000,
      maxLockMs: 120_000,
      now,
    });
  }

  it("sınır altındaki denemelere izin verir", () => {
    let time = 0;
    const rateLimiter = limiter(() => time);

    expect(rateLimiter.check("a").allowed).toBe(true);
    rateLimiter.recordFailure("a");
    time += 1000;
    expect(rateLimiter.check("a").allowed).toBe(true);
    expect(rateLimiter.check("a").remaining).toBe(2);
  });

  it("sınır aşılınca geçici bekleme uygular", () => {
    let time = 0;
    const rateLimiter = limiter(() => time);

    rateLimiter.recordFailure("a");
    rateLimiter.recordFailure("a");
    const third = rateLimiter.recordFailure("a");

    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBe(30_000);
    expect(rateLimiter.check("a").allowed).toBe(false);

    time += 30_001;
    expect(rateLimiter.check("a").allowed).toBe(true);
  });

  it("tekrarlanan ihlalde bekleme süresi artar", () => {
    let time = 0;
    const rateLimiter = limiter(() => time);

    for (let i = 0; i < 3; i += 1) rateLimiter.recordFailure("a");
    time += 30_001;
    for (let i = 0; i < 2; i += 1) rateLimiter.recordFailure("a");
    const second = rateLimiter.recordFailure("a");

    expect(second.retryAfterMs).toBe(60_000);
  });

  it("bekleme süresi üst sınırı aşmaz", () => {
    let time = 0;
    const rateLimiter = limiter(() => time);

    let last = 0;
    for (let round = 0; round < 8; round += 1) {
      for (let i = 0; i < 3; i += 1) last = rateLimiter.recordFailure("a").retryAfterMs;
      time += last + 1;
    }
    expect(last).toBe(120_000);
  });

  it("pencere dışındaki başarısızlıkları unutur", () => {
    let time = 0;
    const rateLimiter = limiter(() => time);

    rateLimiter.recordFailure("a");
    rateLimiter.recordFailure("a");
    time += 61_000;
    expect(rateLimiter.check("a").remaining).toBe(3);
  });

  it("başarılı girişte sayaç sıfırlanır", () => {
    const time = 0;
    const rateLimiter = limiter(() => time);

    rateLimiter.recordFailure("a");
    rateLimiter.recordFailure("a");
    rateLimiter.reset("a");
    expect(rateLimiter.check("a").remaining).toBe(3);
  });

  it("farklı anahtarlar birbirini etkilemez", () => {
    const time = 0;
    const rateLimiter = limiter(() => time);

    for (let i = 0; i < 3; i += 1) rateLimiter.recordFailure("a");
    expect(rateLimiter.check("a").allowed).toBe(false);
    expect(rateLimiter.check("b").allowed).toBe(true);
  });

  it("bekleme süresini Türkçe biçimlendirir", () => {
    expect(formatRetryAfter(30_000)).toBe("30 saniye");
    expect(formatRetryAfter(120_000)).toBe("2 dakika");
  });
});
