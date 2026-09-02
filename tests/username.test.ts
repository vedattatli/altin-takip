import { describe, expect, it } from "vitest";

import { internalEmailForUsername, looksLikeInternalEmail } from "@/auth/internal-identity";
import { normalizeUsername, validateUsername } from "@/auth/username";

describe("kullanıcı adı normalizasyonu", () => {
  it("büyük/küçük harf farkını kaldırır", () => {
    expect(normalizeUsername("Ayse")).toBe("ayse");
    expect(normalizeUsername("AYSE")).toBe("ayse");
    expect(normalizeUsername("aYsE")).toBe("ayse");
  });

  it("aynı adın farklı harf varyasyonları aynı kanonik değeri verir", () => {
    const variants = ["Mehmet", "MEHMET", "mehmet", "MeHmEt"];
    const normalized = new Set(variants.map(normalizeUsername));
    expect(normalized.size).toBe(1);
  });

  it("Türkçe harfleri ASCII karşılığına çevirir", () => {
    expect(normalizeUsername("Şükrü")).toBe("sukru");
    expect(normalizeUsername("çiğdem")).toBe("cigdem");
    expect(normalizeUsername("ÖZGÜR")).toBe("ozgur");
    expect(normalizeUsername("Ilgın")).toBe("ilgin");
    expect(normalizeUsername("İSMAİL")).toBe("ismail");
    expect(normalizeUsername("ismail")).toBe("ismail");
  });

  it("noktalı ve noktasız i varyasyonlarını aynı değere indirger", () => {
    expect(normalizeUsername("İlker")).toBe(normalizeUsername("ilker"));
    expect(normalizeUsername("ILKER")).toBe(normalizeUsername("ilker"));
  });

  it("baştaki ve sondaki boşlukları siler", () => {
    expect(normalizeUsername("  ayse  ")).toBe("ayse");
  });

  it("aksanlı harfleri sadeleştirir", () => {
    expect(normalizeUsername("José")).toBe("jose");
  });
});

describe("kullanıcı adı kuralları", () => {
  it("geçerli adları kabul eder", () => {
    for (const value of ["ayse", "mehmet.yilmaz", "kullanici_01", "test-user", "abc"]) {
      const result = validateUsername(value);
      expect(result.ok, `${value} geçerli olmalı`).toBe(true);
    }
  });

  it("boş değeri reddeder", () => {
    expect(validateUsername("").ok).toBe(false);
    expect(validateUsername("   ").error).toMatch(/boş olamaz/);
  });

  it("boşluk içeren adı reddeder", () => {
    const result = validateUsername("ayse yilmaz");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boşluk/);
  });

  it("çok kısa ve çok uzun adları reddeder", () => {
    expect(validateUsername("ab").error).toMatch(/en az 3/);
    expect(validateUsername("a".repeat(33)).error).toMatch(/en fazla 32/);
  });

  it("harf ile başlamayan adı reddeder", () => {
    expect(validateUsername("1ayse").error).toMatch(/harf ile başlamalıdır/);
    expect(validateUsername("_ayse").error).toMatch(/harf ile başlamalıdır/);
  });

  it("izin verilmeyen özel karakterleri reddeder", () => {
    for (const value of ["ayse!", "ayse@ev", "ayse#1", "ayse/yilmaz", "ayse+1"]) {
      expect(validateUsername(value).ok, `${value} reddedilmeli`).toBe(false);
    }
  });

  it("ayırıcı ile biten veya art arda ayırıcı içeren adı reddeder", () => {
    expect(validateUsername("ayse.").error).toMatch(/bitemez/);
    expect(validateUsername("ayse__yilmaz").error).toMatch(/art arda/);
  });

  it("geçerli sonuçta normalize edilmiş değeri döner", () => {
    expect(validateUsername("  Şükrü  ").value).toBe("sukru");
  });
});

describe("dahili kimlik eşlemesi", () => {
  const DOMAIN = "users.altin-takip.invalid";

  it("kullanıcı adından deterministik adres üretir", () => {
    expect(internalEmailForUsername("ayse", DOMAIN)).toBe("ayse@users.altin-takip.invalid");
    expect(internalEmailForUsername("AYSE", DOMAIN)).toBe("ayse@users.altin-takip.invalid");
    expect(internalEmailForUsername("Şükrü", DOMAIN)).toBe("sukru@users.altin-takip.invalid");
  });

  it("aynı girdi her zaman aynı kimliği verir", () => {
    const first = internalEmailForUsername("mehmet.yilmaz", DOMAIN);
    const second = internalEmailForUsername("Mehmet.Yilmaz", DOMAIN);
    expect(first).toBe(second);
  });

  it("geçersiz girdide hata verir", () => {
    expect(() => internalEmailForUsername("   ", DOMAIN)).toThrow();
    expect(() => internalEmailForUsername("ayse", "")).toThrow();
  });

  it("dahili adres tespit edilebilir (arayüze sızmadığını denetlemek için)", () => {
    expect(looksLikeInternalEmail("ayse@users.altin-takip.invalid", DOMAIN)).toBe(true);
    expect(looksLikeInternalEmail("ayse@ornek.com", DOMAIN)).toBe(false);
  });
});
