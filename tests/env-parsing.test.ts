import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { flagFromEnv, numberFromEnv, stringFromEnv } from "@/lib/env";
import { numberFromEnv as workerNumberFromEnv } from "../services/sarraf-screen-worker/src/policy";

/**
 * ORTAM DEĞİŞKENİ OKUMA — SESSİZ SIFIRA DÜŞME
 *
 * `Number(process.env.X ?? "0.15")` kalıbı, değişken TANIMLI ama BOŞ olduğunda
 * varsayılanı atlar ve `Number("")` = 0 üretir. Bu, Sprint 3.2'de gerçekten
 * yaşandı: `PRICE_MAX_TRY=""` fiyat üst sınırını 0 yaptı ve kalite kapısı
 * bütün fiyatları reddetti — hiçbir log üretmeden.
 */

const KEYS = ["ALTIN_TEST_SAYI", "ALTIN_TEST_METIN", "ALTIN_TEST_BAYRAK"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("1. numberFromEnv", () => {
  it("tanımsızsa varsayılanı döner", () => {
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42)).toBe(42);
  });

  it("BOŞ değer 'ayarlanmamış' sayılır (0 DÖNMEZ)", () => {
    process.env.ALTIN_TEST_SAYI = "";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42)).toBe(42);
  });

  it("yalnızca boşluk içeren değer de 'ayarlanmamış' sayılır", () => {
    process.env.ALTIN_TEST_SAYI = "   ";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42)).toBe(42);
  });

  it("geçerli değeri okur", () => {
    process.env.ALTIN_TEST_SAYI = "0.5";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42)).toBe(0.5);
  });

  it("sayı olmayan değer varsayılana düşer", () => {
    process.env.ALTIN_TEST_SAYI = "abc";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42)).toBe(42);
  });

  it("sonsuz ve NaN kabul edilmez", () => {
    for (const value of ["Infinity", "-Infinity", "NaN"]) {
      process.env.ALTIN_TEST_SAYI = value;
      expect(numberFromEnv("ALTIN_TEST_SAYI", 42), value).toBe(42);
    }
  });

  it("alt sınırın altındaki değer varsayılana düşer", () => {
    process.env.ALTIN_TEST_SAYI = "0";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42, { min: 1 })).toBe(42);
  });

  it("üst sınırın üstündeki değer varsayılana düşer", () => {
    process.env.ALTIN_TEST_SAYI = "999";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42, { max: 100 })).toBe(42);
  });

  it("negatif değer alt sınır varsa reddedilir", () => {
    process.env.ALTIN_TEST_SAYI = "-5";
    expect(numberFromEnv("ALTIN_TEST_SAYI", 42, { min: 0 })).toBe(42);
  });
});

describe("2. stringFromEnv ve flagFromEnv", () => {
  it("boş metin varsayılana düşer", () => {
    process.env.ALTIN_TEST_METIN = "";
    expect(stringFromEnv("ALTIN_TEST_METIN", "varsayilan")).toBe("varsayilan");
  });

  it("metin kırpılarak okunur", () => {
    process.env.ALTIN_TEST_METIN = "  deger  ";
    expect(stringFromEnv("ALTIN_TEST_METIN", "varsayilan")).toBe("deger");
  });

  it("bayrak yalnızca 'true' ile açılır", () => {
    for (const [value, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", false],
      ["yes", false],
      ["false", false],
      ["", false],
    ] as const) {
      process.env.ALTIN_TEST_BAYRAK = value;
      expect(flagFromEnv("ALTIN_TEST_BAYRAK"), `deger=${value}`).toBe(expected);
    }
  });
});

describe("3. worker aynı kuralı uygular", () => {
  it("boş değer worker tarafında da varsayılana düşer", () => {
    // Worker `@/` alias'ını kullanamaz; kuralın iki kopyası aynı davranmalıdır.
    process.env.ALTIN_TEST_SAYI = "";
    expect(workerNumberFromEnv("ALTIN_TEST_SAYI", 60_000)).toBe(60_000);
  });

  it("alt sınır worker tarafında da uygulanır", () => {
    process.env.ALTIN_TEST_SAYI = "0";
    expect(workerNumberFromEnv("ALTIN_TEST_SAYI", 60_000, 1)).toBe(60_000);
  });
});

describe("4. ham Number(process.env...) kalıbı geri gelmez", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
      } else if (/\.(ts|tsx)$/u.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it("src/ ve services/ içinde Number(process.env...) kullanılmaz", () => {
    // Bu kalıp boş değerde sessizce 0 üretir. Yerine numberFromEnv kullanılır.
    const offenders: string[] = [];
    for (const dir of ["src", "services"]) {
      for (const file of sourceFiles(join(process.cwd(), dir))) {
        const source = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/Number\(\s*process\.env/u.test(source)) {
          offenders.push(file.replace(process.cwd(), "").replace(/\\/gu, "/"));
        }
      }
    }
    expect(offenders, `ham kalıp bulundu: ${offenders.join(", ")}`).toEqual([]);
  });
});
