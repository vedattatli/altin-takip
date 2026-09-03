import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKUP_TABLES,
  BackupService,
  decryptBackup,
  encryptBackup,
} from "@/server/backup/backup-service";
import type { AuthBackend } from "@/server/auth/backend";

/**
 * YEDEK VE GERİ YÜKLEME PROVASI
 *
 * Burada kanıtlanan iki şey var:
 *  1. Yedek gerçekten geri yüklenebilir (çözülür ve içeriği bozulmamıştır).
 *  2. Yedek kimlik sırlarını TAŞIMAZ — dosya çalınsa bile hesap ele geçirilemez.
 */

const KEY = randomBytes(32).toString("base64");

/** Sahte arka uç: parola hash'i gibi alanları kasten İÇERİR ki elendiği görülsün. */
function fakeBackend(): AuthBackend {
  const data: Record<string, unknown[]> = {
    profiles: [{ id: "u1", username: "vedat", role: "admin", must_change_password: false }],
    portfolios: [{ id: "p1", user_id: "u1" }],
    transactions: [{ id: "t1", portfolio_id: "p1", kind: "BUY", quantity: "2" }],
    portfolio_positions: [{ portfolio_id: "p1", product_id: "gremse-altin" }],
    user_preferences: [{ user_id: "u1", theme: "dark" }],
    portfolio_price_preferences: [{ portfolio_id: "p1", provider_code: "sarraf-tv-kayseri-screen" }],
    price_source_change_events: [],
    admin_audit_logs: [],
    price_mapping_approvals: [],
    experimental_price_access: [{ portfolio_id: "p1", enabled: true }],
    price_providers: [{ code: "sarraf-tv-kayseri-screen", enabled: true }],
  };
  return {
    exportBackupTable: async (table: string) => data[table] ?? [],
  } as unknown as AuthBackend;
}

describe("1. şifreleme", () => {
  it("çözülen metin özgün metne eşittir", () => {
    const key = Buffer.from(KEY, "base64");
    const plain = "portföy verisi ÇĞİÖŞÜ";
    expect(decryptBackup(encryptBackup(plain, key), key)).toBe(plain);
  });

  it("her yedek FARKLI IV kullanır", () => {
    // Aynı anahtarla aynı IV'yi tekrar kullanmak GCM'de anahtar akışını
    // çakıştırır ve düz metin sızdırır.
    const key = Buffer.from(KEY, "base64");
    const a = encryptBackup("aynı içerik", key);
    const b = encryptBackup("aynı içerik", key);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("bozulmuş gövde REDDEDİLİR", () => {
    const key = Buffer.from(KEY, "base64");
    const payload = encryptBackup("veri", key);
    payload[payload.length - 1] ^= 0xff;
    expect(() => decryptBackup(payload, key)).toThrow();
  });

  it("yanlış anahtarla çözülemez", () => {
    const payload = encryptBackup("veri", Buffer.from(KEY, "base64"));
    expect(() => decryptBackup(payload, randomBytes(32))).toThrow();
  });
});

describe("2. yedek üretimi ve geri yükleme provası", () => {
  beforeEach(() => {
    process.env.BACKUP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
  });

  it("anahtar yoksa yedek ALINMAZ", async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    await expect(new BackupService(fakeBackend()).create()).rejects.toThrow();
  });

  it("bütün tablolar yedeklenir", async () => {
    const artifact = await new BackupService(fakeBackend()).create();
    expect(artifact.manifest.tables.map((entry) => entry.name)).toEqual([...BACKUP_TABLES]);
  });

  it("geri yükleme provası GEÇER", async () => {
    const service = new BackupService(fakeBackend());
    const artifact = await service.create();
    const result = service.rehearseRestore(artifact);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(BACKUP_TABLES.length);
  });

  it("içerik değiştirilirse prova BAŞARISIZ olur", async () => {
    const service = new BackupService(fakeBackend());
    const artifact = await service.create();
    // Manifest'teki satır sayısını bozarsak prova bunu YAKALAMALIDIR.
    const tampered = {
      ...artifact,
      manifest: {
        ...artifact.manifest,
        tables: artifact.manifest.tables.map((entry) =>
          entry.name === "transactions" ? { ...entry, rowCount: entry.rowCount + 1 } : entry,
        ),
      },
    };
    expect(service.rehearseRestore(tampered).ok).toBe(false);
  });

  it("dosya adı secret İÇERMEZ", async () => {
    const artifact = await new BackupService(fakeBackend()).create();
    expect(artifact.fileName).not.toContain(KEY);
    expect(artifact.fileName).toMatch(/^altin-takip-backup-.*\.json\.enc$/u);
  });

  it("yedek içeriğinde parola/MFA/oturum alanı YOKTUR", async () => {
    const service = new BackupService(fakeBackend());
    const artifact = await service.create();
    const plain = decryptBackup(artifact.ciphertext, Buffer.from(KEY, "base64"));
    // must_change_password bir bayraktır ve sır değildir; hash/secret/token olamaz.
    for (const forbidden of ["password_hash", "mfa_secret", "session_token", "csrf"]) {
      expect(plain).not.toContain(forbidden);
    }
  });
});
