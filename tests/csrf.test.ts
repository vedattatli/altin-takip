import { describe, expect, it } from "vitest";

import {
  checkOrigin,
  createSignedCsrfCookie,
  readSignedCsrfCookie,
  STATE_CHANGING_METHODS,
  verifyCsrf,
} from "@/server/security/csrf";
import { expectedOrigins } from "@/server/security/origins";
import { readCookie } from "@/server/security/route";

const SECRET = "test-csrf-gizli-anahtari";

function headersOf(values: Record<string, string>) {
  return new Headers(values);
}

describe("imzalı CSRF jetonu", () => {
  it("üretilen çerez değeri doğrulanabilir", async () => {
    const { token, cookieValue } = await createSignedCsrfCookie(SECRET);
    expect(cookieValue.startsWith(`${token}.`)).toBe(true);
    expect(await readSignedCsrfCookie(cookieValue, SECRET)).toBe(token);
  });

  it("her jeton benzersizdir", async () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      tokens.add((await createSignedCsrfCookie(SECRET)).token);
    }
    expect(tokens.size).toBe(20);
  });

  it("imza bozulursa reddedilir", async () => {
    const { cookieValue } = await createSignedCsrfCookie(SECRET);
    const lastChar = cookieValue.slice(-1);
    const tampered = `${cookieValue.slice(0, -1)}${lastChar === "0" ? "1" : "0"}`;
    expect(await readSignedCsrfCookie(tampered, SECRET)).toBeNull();
  });

  it("başka anahtarla imzalanmış jeton kabul edilmez", async () => {
    const { cookieValue } = await createSignedCsrfCookie("baska-anahtar");
    expect(await readSignedCsrfCookie(cookieValue, SECRET)).toBeNull();
  });

  it("saldırganın kendi ürettiği jeton geçerli imza taşımaz", async () => {
    // Alt alan adından çerez yazılsa bile imza üretilemez.
    expect(await readSignedCsrfCookie("uydurma-deger.uydurma-imza", SECRET)).toBeNull();
    expect(await readSignedCsrfCookie("imzasiz", SECRET)).toBeNull();
    expect(await readSignedCsrfCookie(undefined, SECRET)).toBeNull();
  });

  it("başlık ile çerez eşleşmezse doğrulama başarısız olur", async () => {
    const { token, cookieValue } = await createSignedCsrfCookie(SECRET);
    const other = await createSignedCsrfCookie(SECRET);

    expect(await verifyCsrf(cookieValue, token, SECRET)).toBe(true);
    expect(await verifyCsrf(cookieValue, other.token, SECRET)).toBe(false);
    expect(await verifyCsrf(cookieValue, null, SECRET)).toBe(false);
    expect(await verifyCsrf(undefined, token, SECRET)).toBe(false);
  });
});

describe("origin kontrolü", () => {
  const ORIGINS = ["https://altin-takip.ornek.com"];

  it("aynı origin'den gelen istek kabul edilir", () => {
    const result = checkOrigin(
      headersOf({ origin: ORIGINS[0], "sec-fetch-site": "same-origin" }),
      ORIGINS,
    );
    expect(result.ok).toBe(true);
  });

  it("başka origin reddedilir", () => {
    const result = checkOrigin(
      headersOf({ origin: "https://kotu-site.example", "sec-fetch-site": "cross-site" }),
      ORIGINS,
    );
    expect(result.ok).toBe(false);
  });

  it("origin doğru olsa bile cross-site fetch reddedilir", () => {
    const result = checkOrigin(
      headersOf({ origin: ORIGINS[0], "sec-fetch-site": "cross-site" }),
      ORIGINS,
    );
    expect(result.ok).toBe(false);
  });

  it("alt alan adından gelen istek (same-site) reddedilir", () => {
    const result = checkOrigin(
      headersOf({ origin: "https://alt.altin-takip.ornek.com", "sec-fetch-site": "same-site" }),
      ORIGINS,
    );
    expect(result.ok).toBe(false);
  });

  it("origin ve sec-fetch-site birlikte eksikse reddedilir", () => {
    expect(checkOrigin(headersOf({}), ORIGINS).ok).toBe(false);
  });

  it("adres çubuğundan yapılan gezinme (none) kabul edilir", () => {
    expect(checkOrigin(headersOf({ "sec-fetch-site": "none" }), ORIGINS).ok).toBe(true);
  });
});

describe("beklenen origin çözümü", () => {
  it("APP_ORIGIN verilmişse yalnızca o kabul edilir", () => {
    const result = expectedOrigins(headersOf({ host: "baska.example" }), "https://ornek.com/", false);
    expect(result).toEqual(["https://ornek.com"]);
  });

  it("APP_ORIGIN yoksa istek başlıklarından türetilir", () => {
    const result = expectedOrigins(
      headersOf({ host: "localhost:3000", "x-forwarded-proto": "http" }),
      "",
      false,
    );
    expect(result).toEqual(["http://localhost:3000"]);
  });

  it("host yoksa hiçbir origin kabul edilmez", () => {
    expect(expectedOrigins(headersOf({}), "", false)).toEqual([]);
  });
});

describe("kapsam", () => {
  it("yalnızca durum değiştiren yöntemler korunur", () => {
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
    expect(STATE_CHANGING_METHODS.has("GET")).toBe(false);
    expect(STATE_CHANGING_METHODS.has("HEAD")).toBe(false);
  });
});

describe("çerez okuma", () => {
  it("doğru çerezi ayıklar", () => {
    const header = "a=1; altin_takip_csrf=deger.imza; b=2";
    expect(readCookie(header, "altin_takip_csrf")).toBe("deger.imza");
    expect(readCookie(header, "yok")).toBeUndefined();
  });

  it("benzer adlı çerezle karışmaz", () => {
    const header = "xaltin_takip_csrf=yanlis; altin_takip_csrf=dogru";
    expect(readCookie(header, "altin_takip_csrf")).toBe("dogru");
  });
});
