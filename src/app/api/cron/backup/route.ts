import { BackupService } from "@/server/backup/backup-service";
import { getAuthBackend } from "@/server/auth";
import { ok } from "@/server/http";
import { machineRoute } from "@/server/security/machine-route";
import { uploadBackup, pruneOldBackups } from "@/server/backup/backup-storage";

/**
 * GÜNLÜK UYGULAMA YEDEĞİ
 *
 * - MAKİNE ucudur: zamanlayıcının çerezi yoktur, `machineRoute` kullanılır.
 * - `BACKUP_CRON_SECRET` yoksa uç KAPALIDIR (fail closed).
 * - Vercel Hobby planında cron günde bir kez çalışabilir; buna uygundur.
 * - Yanıt secret, anahtar veya yedek İÇERİĞİ döndürmez; yalnız üst veri.
 *
 * Bu TAM PITR DEĞİLDİR. Uygulama düzeyinde bir dışa aktarımdır ve yanıt
 * bunu açıkça söyler.
 */
export const dynamic = "force-dynamic";

export const POST = machineRoute(
  { secretEnv: "BACKUP_CRON_SECRET", runKeyPrefix: "backup" },
  async () => {
    const service = new BackupService(getAuthBackend());
    const artifact = await service.create();

    // Şifreli gövde private bucket'a yazılır. Anahtar YAZILMAZ.
    await uploadBackup(artifact.fileName, artifact.ciphertext, artifact.manifest);

    // 7 günlük saklama: daha eskiler silinir.
    const pruned = await pruneOldBackups(7);

    // GERİ YÜKLEME PROVASI her yedekte çalışır: yedeğin gerçekten
    // çözülebildiği ve içeriğinin bozulmadığı kanıtlanır. Üretim tablolarına
    // YAZMAZ.
    const rehearsal = service.rehearseRestore(artifact);

    return ok({
      fileName: artifact.fileName,
      schemaVersion: artifact.manifest.schemaVersion,
      tables: artifact.manifest.tables.map((entry) => ({
        name: entry.name,
        rowCount: entry.rowCount,
      })),
      bytes: artifact.ciphertext.byteLength,
      prunedCount: pruned,
      restoreRehearsal: { ok: rehearsal.ok, checked: rehearsal.checked, mismatches: rehearsal.mismatches },
      note: "Bu uygulama verisi yedeğidir; tam veritabanı PITR değildir.",
    });
  },
);
