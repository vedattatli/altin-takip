import "server-only";

import { stringFromEnv } from "@/lib/env";
import type { BackupManifest } from "./backup-service";

/**
 * YEDEK DEPOLAMA — Supabase Storage (PRIVATE bucket)
 *
 * Bucket herkese açık DEĞİLDİR: imzasız URL ile okunamaz. Yedek gövdesi zaten
 * AES-256-GCM ile şifrelidir, yani bucket yanlışlıkla açılsa bile içerik
 * anahtarsız okunamaz. İki katman bilinçlidir.
 *
 * Manifest ayrı bir dosya olarak yazılır ve ŞİFRESİZDİR: satır sayıları ve
 * içerik özetleri hassas veri değildir, ama geri yükleme provasında gövdeyi
 * çözmeden bütünlük kontrolü yapmayı sağlar.
 */

const BUCKET = "app-backups";

function storageConfig(): { url: string; key: string } {
  const url = stringFromEnv("NEXT_PUBLIC_SUPABASE_URL", "").replace(/\/$/u, "");
  const key = stringFromEnv("SUPABASE_SECRET_KEY", "");
  if (url === "" || key === "") {
    throw new Error("Yedek depolaması yapılandırılmadı.");
  }
  return { url, key };
}

async function storageFetch(path: string, init: RequestInit): Promise<Response> {
  const { url, key } = storageConfig();
  return fetch(`${url}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
}

/** Bucket yoksa private olarak oluşturur. Var olan bucket'ı DEĞİŞTİRMEZ. */
async function ensureBucket(): Promise<void> {
  const existing = await storageFetch(`bucket/${BUCKET}`, { method: "GET" });
  if (existing.ok) return;
  await storageFetch("bucket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // public: false — imzasız erişim yok.
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
}

export async function uploadBackup(
  fileName: string,
  ciphertext: Buffer,
  manifest: BackupManifest,
): Promise<void> {
  await ensureBucket();

  const body = await storageFetch(`object/${BUCKET}/${fileName}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!body.ok && body.status !== 409) {
    throw new Error(`Yedek yüklenemedi (HTTP ${String(body.status)}).`);
  }

  const manifestResponse = await storageFetch(`object/${BUCKET}/${fileName}.manifest.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest, null, 2),
  });
  if (!manifestResponse.ok && manifestResponse.status !== 409) {
    throw new Error(`Yedek manifesti yüklenemedi (HTTP ${String(manifestResponse.status)}).`);
  }
}

/**
 * Saklama süresi dolan yedekleri siler.
 *
 * Silme SAYISI döner. Silinemeyen dosya yedeği başarısız SAYMAZ: yeni yedeğin
 * alınmış olması, eski dosyanın temizlenmesinden daha önemlidir.
 */
export async function pruneOldBackups(retentionDays: number): Promise<number> {
  const listing = await storageFetch(`object/list/${BUCKET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  if (!listing.ok) return 0;

  const files = (await listing.json()) as { name: string; created_at?: string }[];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const doomed = files
    .filter((file) => {
      const created = file.created_at === undefined ? NaN : Date.parse(file.created_at);
      return Number.isFinite(created) && created < cutoff;
    })
    .map((file) => file.name);

  if (doomed.length === 0) return 0;

  const removal = await storageFetch(`object/${BUCKET}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: doomed }),
  });
  return removal.ok ? doomed.length : 0;
}
