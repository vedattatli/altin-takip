import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { stringFromEnv } from "@/lib/env";
import type { AuthBackend } from "@/server/auth/backend";

/**
 * ÜCRETSİZ UYGULAMA YEDEĞİ
 *
 * Bu TAM VERİTABANI PITR DEĞİLDİR. Supabase Free planında fiziksel
 * point-in-time recovery yoktur; burada yapılan, pilot verilerini geri
 * kazanmaya yetecek UYGULAMA DÜZEYİNDE bir dışa aktarımdır.
 *
 * YEDEKLENMEYENLER (bilinçli):
 *  - parola hash'leri
 *  - MFA secret'ları (şifreli hâlleri bile)
 *  - oturum ve CSRF token'ları
 *  - worker HMAC secret'ı, API anahtarları
 *  - çerezler
 *
 * Bunlar yedekte olsaydı, yedek dosyası tek başına hesapları ele geçirmeye
 * yeterdi. Kimlik verileri kaybolursa yönetici parolayı sıfırlar ve MFA'yı
 * yeniden kurar; portföy verisi ise geri getirilemez — korunması gereken odur.
 *
 * Şifreleme: AES-256-GCM (authenticated encryption). Anahtar yalnız sunucu
 * secret store'undadır (BACKUP_ENCRYPTION_KEY) ve yedeğin içine YAZILMAZ.
 */

const ALGORITHM = "aes-256-gcm";
const SCHEMA_VERSION = 1;

/** Yedeklenen tablolar. Sıralama geri yükleme bağımlılığına göredir. */
export const BACKUP_TABLES = [
  "profiles",
  "portfolios",
  "transactions",
  "portfolio_positions",
  "user_preferences",
  "portfolio_price_preferences",
  "price_source_events",
  "price_mapping_approvals",
  "experimental_price_access",
  "price_providers",
] as const;

export interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  tables: { name: string; rowCount: number; contentHash: string }[];
  /** Şifresiz içeriğin tamamının özeti; geri yükleme doğrulaması için. */
  payloadHash: string;
}

export interface BackupArtifact {
  /** Dosya adı: zaman damgası + şema sürümü. Secret İÇERMEZ. */
  fileName: string;
  /** AES-256-GCM ile şifreli gövde. */
  ciphertext: Buffer;
  manifest: BackupManifest;
}

export class BackupKeyMissingError extends Error {
  constructor() {
    super("BACKUP_ENCRYPTION_KEY tanımlı değil; yedek alınamaz.");
    this.name = "BackupKeyMissingError";
  }
}

function readKey(): Buffer {
  const raw = stringFromEnv("BACKUP_ENCRYPTION_KEY", "");
  if (raw === "") throw new BackupKeyMissingError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new BackupKeyMissingError();
  }
  return key;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Şifreler. Her yedek YENİ bir rastgele IV kullanır: aynı anahtarla aynı IV'yi
 * tekrar kullanmak GCM'de felakettir (anahtar akışı çakışır).
 */
export function encryptBackup(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Biçim: [12 bayt IV][16 bayt doğrulama etiketi][şifreli gövde]
  return Buffer.concat([iv, tag, body]);
}

/** Çözer. Etiket doğrulanmazsa hata fırlatır — bozuk yedek sessizce kabul edilmez. */
export function decryptBackup(payload: Buffer, key: Buffer): string {
  if (payload.length < 28) throw new Error("Yedek gövdesi geçersiz.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const body = payload.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export class BackupService {
  constructor(private readonly backend: AuthBackend) {}

  /** Yedeği üretir ve şifreler. Secret'lar dışarıda bırakılır. */
  async create(now: Date = new Date()): Promise<BackupArtifact> {
    const key = readKey();
    const tables: BackupManifest["tables"] = [];
    const data: Record<string, unknown[]> = {};

    for (const table of BACKUP_TABLES) {
      const rows = await this.backend.exportBackupTable(table);
      data[table] = rows;
      const serialized = JSON.stringify(rows);
      tables.push({ name: table, rowCount: rows.length, contentHash: sha256(serialized) });
    }

    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, createdAt: now.toISOString(), data });
    const manifest: BackupManifest = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: now.toISOString(),
      tables,
      payloadHash: sha256(payload),
    };

    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    return {
      fileName: `altin-takip-backup-${stamp}-v${String(SCHEMA_VERSION)}.json.enc`,
      ciphertext: encryptBackup(payload, key),
      manifest,
    };
  }

  /**
   * GERİ YÜKLEME PROVASI
   *
   * Şifreyi çözer, satır sayılarını ve içerik özetlerini manifest ile
   * karşılaştırır. ÜRETİM TABLOLARINA YAZMAZ — yalnız yedeğin gerçekten
   * geri yüklenebilir olduğunu kanıtlar.
   */
  rehearseRestore(artifact: BackupArtifact): { ok: boolean; checked: number; mismatches: string[] } {
    const key = readKey();
    const plaintext = decryptBackup(artifact.ciphertext, key);
    const mismatches: string[] = [];

    if (sha256(plaintext) !== artifact.manifest.payloadHash) {
      mismatches.push("payloadHash");
    }

    const parsed = JSON.parse(plaintext) as { data: Record<string, unknown[]> };
    for (const entry of artifact.manifest.tables) {
      const rows = parsed.data[entry.name] ?? [];
      if (rows.length !== entry.rowCount) {
        mismatches.push(`${entry.name}: satır sayısı ${String(rows.length)} ≠ ${String(entry.rowCount)}`);
        continue;
      }
      if (sha256(JSON.stringify(rows)) !== entry.contentHash) {
        mismatches.push(`${entry.name}: içerik özeti uyuşmuyor`);
      }
    }

    return { ok: mismatches.length === 0, checked: artifact.manifest.tables.length, mismatches };
  }
}
