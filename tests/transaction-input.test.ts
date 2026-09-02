import { beforeEach, describe, expect, it } from "vitest";

import type { UserProfile } from "@/auth/types";
import { LocalAuthBackend } from "@/server/auth/local-backend";
import { UserPortfolioService } from "@/server/portfolio/user-portfolio-service";
import { userActor } from "./actors";

/**
 * SIKI GİRDİ DOĞRULAMA (parseInput)
 *
 * - side yalnızca "buy" | "sell"; başka değer sessizce alışa çevrilmez.
 * - productId katalogda olmalı; birim istemciden değil katalogdan alınır.
 * - Sayısal alanlar sonlu olmalı; NaN/Infinity/negatif/sıfır reddedilir.
 * Hepsi 400 bad_request döner; hiçbir durumda kayıt oluşmaz.
 */

const PASSWORD = "Kuyumcu7Defter";

let backend: LocalAuthBackend;
let service: UserPortfolioService;
let ayse: UserProfile;

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: "gram-altin",
    side: "buy",
    quantity: 2,
    tradedAt: "2026-01-10",
    unitPrice: 5000,
    feeAmount: 0,
    note: "",
    ...overrides,
  };
}

async function expectRejected(body: Record<string, unknown>, messagePart: string) {
  await expect(service.createTransaction(userActor(ayse), body)).rejects.toMatchObject({
    status: 400,
    code: "bad_request",
    message: expect.stringContaining(messagePart),
  });
  expect(await backend.listTransactions({ userId: ayse.id, origin: "self" } as never)).toHaveLength(
    0,
  );
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
  it("geçersiz veya eksik side reddedilir; alışa çevrilmez", async () => {
    await expectRejected(valid({ side: "auto-buy" }), "alış veya satış");
    await expectRejected(valid({ side: "BUY" }), "alış veya satış");
    await expectRejected(valid({ side: undefined }), "alış veya satış");
    await expectRejected(valid({ side: 1 }), "alış veya satış");
  });

  it("buy ve sell kabul edilir", async () => {
    const bought = await service.createTransaction(userActor(ayse), valid({ quantity: 5 }));
    expect(bought.side).toBe("buy");
    const sold = await service.createTransaction(
      userActor(ayse),
      valid({ side: "sell", quantity: 1 }),
    );
    expect(sold.side).toBe("sell");
  });
});

describe("ürün ve birim", () => {
  it("katalogda olmayan ürün reddedilir", async () => {
    await expectRejected(valid({ productId: "bitcoin" }), "geçerli bir altın türü");
    await expectRejected(valid({ productId: "" }), "geçerli bir altın türü");
    await expectRejected(valid({ productId: 42 }), "geçerli bir altın türü");
  });

  it("birim istemciden değil katalogdan alınır", async () => {
    const created = await service.createTransaction(
      userActor(ayse),
      valid({ productId: "gram-altin", unit: "adet" }),
    );
    expect(created.unit).toBe("gram");

    const piece = await service.createTransaction(
      userActor(ayse),
      valid({ productId: "yeni-ceyrek", quantity: 3, unit: "gram" }),
    );
    expect(piece.unit).toBe("adet");
  });
});

describe("sayısal alanlar", () => {
  it("NaN, Infinity ve sayı olmayan değerler reddedilir", async () => {
    await expectRejected(valid({ quantity: Number.NaN }), "Miktar");
    await expectRejected(valid({ quantity: Number.POSITIVE_INFINITY }), "Miktar");
    await expectRejected(valid({ quantity: "abc" }), "Miktar");
    await expectRejected(valid({ quantity: {} }), "Miktar");
    await expectRejected(valid({ unitPrice: Number.NaN }), "Birim fiyat");
    await expectRejected(valid({ unitPrice: "" }), "Birim fiyat");
    await expectRejected(valid({ feeAmount: Number.NEGATIVE_INFINITY }), "komisyon");
  });

  it("sıfır ve negatif miktar / fiyat reddedilir", async () => {
    await expectRejected(valid({ quantity: 0 }), "Miktar sıfırdan büyük");
    await expectRejected(valid({ quantity: -1 }), "Miktar sıfırdan büyük");
    await expectRejected(valid({ unitPrice: 0 }), "Birim fiyat sıfırdan büyük");
    await expectRejected(valid({ unitPrice: -5000 }), "Birim fiyat sıfırdan büyük");
    await expectRejected(valid({ feeAmount: -1 }), "negatif olamaz");
  });

  it("sayı biçimli dizeler kabul edilir ve normalize edilir", async () => {
    const created = await service.createTransaction(
      userActor(ayse),
      valid({ quantity: "2.5", unitPrice: "5100", feeAmount: "10" }),
    );
    expect(created.quantity).toBe(2.5);
    expect(created.unitPrice).toBe(5100);
    expect(created.feeAmount).toBe(10);
  });

  it("feeAmount verilmezse 0 kabul edilir", async () => {
    const body = valid();
    delete body.feeAmount;
    const created = await service.createTransaction(userActor(ayse), body);
    expect(created.feeAmount).toBe(0);
  });
});

describe("gövde biçimi", () => {
  it("nesne olmayan gövde reddedilir", async () => {
    for (const body of [null, "x", 42, []]) {
      await expect(service.createTransaction(userActor(ayse), body)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("not alanı 280 karakterle sınırlanır ve dize değilse boş kabul edilir", async () => {
    const long = "a".repeat(400);
    const created = await service.createTransaction(userActor(ayse), valid({ note: long }));
    expect(created.note).toHaveLength(280);

    const noNote = await service.createTransaction(userActor(ayse), valid({ note: 123 }));
    expect(noNote.note).toBe("");
  });
});
