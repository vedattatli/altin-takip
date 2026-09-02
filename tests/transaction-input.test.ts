import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { userActor } from "./actors";
import { buyCommand } from "./helpers";

/**
 * SUNUCU TARAFI SIKI GİRDİ DOĞRULAMA (UserPortfolioService.appendTransaction)
 *
 * - kind yalnızca OPENING_BALANCE | BUY | SELL; başka değer sessizce çevrilmez.
 * - productId katalogda olmalı; birim istemciden alınmaz.
 * - Sayısal alanlar ondalık dize; NaN/Infinity/bilimsel/negatif/sıfır reddedilir.
 * Hepsi 400 bad_request döner; hiçbir durumda kayıt oluşmaz.
 */

const PASSWORD = "Kuyumcu7Defter";

let backend: LocalAuthBackend;
let service: UserPortfolioService;
let ayse: UserProfile;

async function expectRejected(body: unknown, messagePart: string, code = "bad_request") {
  await expect(service.appendTransaction(userActor(ayse), body)).rejects.toMatchObject({
    status: 400,
    code,
    message: expect.stringContaining(messagePart),
  });
  expect(await service.listLedger(userActor(ayse))).toHaveLength(0);
}

beforeEach(async () => {
  backend = new LocalAuthBackend({ inMemory: true });
  service = new UserPortfolioService(backend);
  ayse = await backend.createUser({
    username: "ayse",
    displayName: "Ayşe Kullanıcı",
    temporaryPassword: PASSWORD,
    role: "user",
  });
  ayse = await backend.setMustChangePassword(ayse.id, false);
});

describe("işlem türü", () => {
  it("geçersiz veya eksik kind reddedilir; alışa çevrilmez", async () => {
    await expectRejected({ ...buyCommand(), kind: "auto-buy" }, "İşlem türü");
    await expectRejected({ ...buyCommand(), kind: "buy" }, "İşlem türü");
    await expectRejected({ ...buyCommand(), kind: undefined }, "İşlem türü");
    await expectRejected({ ...buyCommand(), kind: 1 }, "İşlem türü");
  });

  it("eski 'side' alanı kabul edilmez", async () => {
    const { kind: _kind, ...legacy } = buyCommand();
    await expectRejected({ ...legacy, side: "buy" }, "İşlem türü");
  });
});

describe("ürün ve birim", () => {
  it("katalogda olmayan ürün reddedilir", async () => {
    await expectRejected(buyCommand({ productId: "bitcoin" }), "geçerli bir altın türü");
    await expectRejected(buyCommand({ productId: "" }), "geçerli bir altın türü");
    await expectRejected({ ...buyCommand(), productId: 42 }, "geçerli bir altın türü");
  });

  it("birim istemciden değil katalogdan alınır", async () => {
    const created = await service.appendTransaction(userActor(ayse), { ...buyCommand(), unit: "adet" });
    expect(created.entry.unit).toBe("gram");
    const piece = await service.appendTransaction(userActor(ayse), {
      ...buyCommand({ productId: "yeni-ceyrek", quantity: "3", unitPrice: "11000" }),
      unit: "gram",
    });
    expect(piece.entry.unit).toBe("adet");
  });
});

describe("sayısal alanlar", () => {
  it("NaN, Infinity, bilimsel gösterim ve sayı olmayan değerler reddedilir", async () => {
    await expectRejected({ ...buyCommand(), quantity: Number.NaN }, "Miktar");
    await expectRejected({ ...buyCommand(), quantity: Number.POSITIVE_INFINITY }, "Miktar");
    await expectRejected(buyCommand({ quantity: "1e3" }), "Miktar");
    await expectRejected(buyCommand({ quantity: "abc" }), "Miktar");
    await expectRejected({ ...buyCommand(), quantity: {} }, "Miktar");
    await expectRejected(buyCommand({ unitPrice: "NaN" }), "sayı");
    await expectRejected(buyCommand({ unitPrice: "" }), "zorunlu");
    await expectRejected(buyCommand({ fees: "-1" }), "negatif");
  });

  it("sıfır ve negatif miktar / fiyat reddedilir", async () => {
    await expectRejected(buyCommand({ quantity: "0" }), "sıfırdan büyük");
    await expectRejected(buyCommand({ quantity: "-1" }), "negatif");
    await expectRejected(buyCommand({ unitPrice: "0" }), "sıfırdan büyük");
    await expectRejected(buyCommand({ unitPrice: "-5000" }), "negatif");
  });

  it("aşırı büyük değer reddedilir", async () => {
    await expectRejected(buyCommand({ unitPrice: "9999999999999" }), "çok büyük");
  });

  it("virgüllü Türkçe biçim kabul edilir ve normalize edilir", async () => {
    const created = await service.appendTransaction(
      userActor(ayse),
      buyCommand({ quantity: "2,5", unitPrice: "5.100,50", fees: "10" }),
    );
    expect(created.entry.quantity).toBe("2.5");
    expect(created.entry.grossAmount).toBe("12751.25");
    expect(created.entry.totalPaid).toBe("12761.25");
  });

  it("adet ürününde ondalık miktar reddedilir", async () => {
    await expectRejected(buyCommand({ productId: "yeni-ceyrek", quantity: "1.5", unitPrice: "11000" }), "tam sayı");
  });
});

describe("gövde biçimi", () => {
  it("nesne olmayan gövde reddedilir", async () => {
    for (const body of [null, "x", 42, []]) {
      await expect(service.appendTransaction(userActor(ayse), body)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("not alanı 280 karakterle sınırlanır", async () => {
    await expectRejected(buyCommand({ note: "a".repeat(400) }), "280");
    const created = await service.appendTransaction(userActor(ayse), { ...buyCommand(), note: 123 });
    expect(created.entry.note).toBe("");
  });

  it("MARKET_BASELINE için istemcinin gönderdiği fiyat yok sayılır; sunucu fiyatı kullanılır", async () => {
    const result = await service.appendTransaction(userActor(ayse), {
      kind: "OPENING_BALANCE",
      productId: "gram-altin",
      quantity: "10",
      costMethod: "MARKET_BASELINE",
      liquidationPrice: "1",
      costAmount: "1",
    });
    expect(result.entry.costBasisOrigin).toBe("MARKET_BASELINE");
    expect(result.entry.priceSnapshot?.provider).toBe("mock");
    expect(result.entry.priceSnapshot?.liquidationPrice).not.toBe("1");
    expect(result.entry.totalPaid).not.toBe("10");
  });
});
