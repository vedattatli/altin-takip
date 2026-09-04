import "server-only";

import { validatePassword } from "@/auth/password";
import {
  type AdminAction,
  type AdminAuditLog,
  type SessionSummary,
  type UserProfile,
  type UserStatus,
} from "@/auth/types";
import { isReservedUsername, validateUsername } from "@/auth/username";
import { approvalAppliesToCurrentMapping } from "@/prices/providers/sarraf-tv-screen-mapping";
import { PLAN_PROVIDER_CODES } from "@/prices/valuation-plan";
import type { AdminActor } from "@/server/auth/actor";
import type { AuthBackend } from "@/server/auth/backend";
import { badRequest, conflict, notFound } from "@/server/auth/errors";
import { ProviderNotSelectableError } from "@/server/prices/types";

/**
 * Yönetim işlemleri.
 *
 * BU SERVİSİN HER METODU `AdminActor` İSTER. AdminActor yalnızca
 * `requireCurrentAdmin()` tarafından üretilir; normal kullanıcı route'ları
 * böyle bir değer oluşturamaz. Başka kullanıcıyı hedefleyen her veri erişimi
 * `adminScope()` ile açıkça işaretlenir ve denetim kaydı üretir.
 *
 * Rol İSTEMCİDEN ALINMAZ: panelden oluşturulan her hesap "user" rolündedir.
 */


export interface DeleteUserResult {
  deleted: boolean;
  /**
   * Silme başarılı olduğu hâlde son denetim kaydı yazılamadıysa true olur.
   * Bu durum gizlenmez; yanıtta döner ve sunucuya kritik seviyede loglanır.
   */
  auditWriteFailed: boolean;
}

/** Denetim kaydı yazılamadığında operasyonel olarak fark edilebilir iz. */
export const AUDIT_WRITE_FAILURE_MARKER = "ALTIN_AUDIT_WRITE_FAILURE";

export interface AdminServiceOptions {
  /** Testlerde sabitlenebilir zaman kaynağı. */
  now?: () => number;
}

export class AdminService {
  private readonly now: () => number;

  constructor(
    private readonly backend: AuthBackend,
    options: AdminServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private async audit(
    actor: AdminActor,
    action: AdminAction,
    target: UserProfile | null,
    success: boolean,
    metadata: AdminAuditLog["metadata"] = {},
  ): Promise<boolean> {
    // Parola, oturum jetonu, ham IP veya finansal içerik ASLA yazılmaz.
    try {
      await this.backend.appendAudit({
        adminUserId: actor.profile.id,
        adminUsername: actor.profile.username,
        targetUserId: target?.id ?? null,
        targetUsername: target?.username ?? null,
        action,
        success,
        metadata,
      });
      return true;
    } catch (error) {
      // Denetim kaydı yazılamazsa sessiz kalınmaz.
      console.error(AUDIT_WRITE_FAILURE_MARKER, {
        action,
        adminUserId: actor.profile.id,
        targetUserId: target?.id ?? null,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // --- Fiyat kaynakları (Sprint 3) ---

  /** Yönetici sağlayıcıyı etkinleştirir / kullanıcıya açar. Her değişiklik denetlenir. */
  async setPriceProviderFlags(
    actor: AdminActor,
    code: string,
    enabled: boolean,
    userSelectable: boolean,
  ): Promise<unknown> {
    const { PriceIngestionService } = await import("@/server/prices/ingestion-service");
    // Katalog hiç eşitlenmemişse sağlayıcı satırı bulunmaz; eşitleme idempotenttir.
    await new PriceIngestionService(this.backend, { now: () => this.now() }).ensureCatalog();
    try {
      const row = await this.backend.setPriceProviderFlags(code, enabled, userSelectable);
      await this.audit(actor, "price.provider_update", null, true, { providerCode: code, enabled, userSelectable });
      return row;
    } catch (error) {
      await this.audit(actor, "price.provider_update", null, false, { providerCode: code, enabled, userSelectable });
      if (error instanceof ProviderNotSelectableError) throw conflict(error.message);
      throw error;
    }
  }

  /** Yönetici: karantinaya alınmış fiyat kayıtları (salt okunur). */
  async listPriceQuarantine(actor: AdminActor, code: string | null, limit = 50): Promise<unknown> {
    const rows = await this.backend.listPriceQuarantine(code, limit);
    await this.audit(actor, "price.quarantine_view", null, true, {
      providerCode: code ?? "all",
      count: rows.length,
    });
    return rows;
  }

  /**
   * Yönetici: AÇIK global varsayılan kaynağı belirler.
   * Tercihi olmayan kullanıcılar bu kaynağı kullanır; mevcut tercihler değişmez.
   */
  async setDefaultPriceProvider(actor: AdminActor, code: string | null): Promise<string | null> {
    try {
      const result = await this.backend.setDefaultPriceProvider(code);
      await this.audit(actor, "price.default_source", null, true, { providerCode: code ?? "none" });
      return result;
    } catch (error) {
      await this.audit(actor, "price.default_source", null, false, { providerCode: code ?? "none" });
      if (error instanceof ProviderNotSelectableError) throw conflict(error.message);
      throw error;
    }
  }


  /** Onaylanmış ekran eşlemeleri. */
  /**
   * Onay listesi, her satırın DEĞERLEMEDE GEÇERLİ OLUP OLMADIĞI ile birlikte
   * döner.
   *
   * Bu alan olmadan yönetim ekranı bütün onayları geçerli sanıyordu: fiyat
   * yolu eski sürümdeki onayları atarken ekran onları yeşil OPERATOR_VERIFIED
   * gösteriyor, ürün fiyatsız kalıyor ve sebebi hiçbir yerde görünmüyordu.
   * Karar tek kaynaktan (`approvalAppliesToCurrentMapping`) gelir.
   */
  async listMappingApprovals(actor: AdminActor, code: string): Promise<unknown> {
    const rows = await this.backend.listMappingApprovals(code);
    await this.audit(actor, "price.mapping_approve", null, true, {
      providerCode: code,
      action: "list",
      count: rows.length,
    });
    return rows.map((row) => ({
      ...row,
      appliesToCurrentMapping: approvalAppliesToCurrentMapping(row.mappingVersion, row.canonicalProductId),
    }));
  }

  /**
   * Yönetici, ekran etiketi ↔ kanonik ürün eşlemesini kanıtıyla onaylar.
   * Onay, CONVENTION eşlemesini OPERATOR_VERIFIED'a yükseltir ve ancak o zaman
   * fiyat değerlemeye girebilir.
   */
  async approveMapping(
    actor: AdminActor,
    input: {
      code: string;
      rawLabel: string;
      canonicalProductId: string;
      mappingVersion: string;
      evidenceLiquidation: string | null;
      evidenceReplacement: string | null;
      evidenceObservedAt: string | null;
      revoke: boolean;
    },
  ): Promise<void> {
    try {
      await this.backend.approvePriceMapping({ ...input, adminId: actor.profile.id });
      await this.audit(actor, "price.mapping_approve", null, true, {
        providerCode: input.code,
        rawLabel: input.rawLabel,
        productId: input.canonicalProductId,
        revoked: input.revoke,
      });
    } catch (error) {
      await this.audit(actor, "price.mapping_approve", null, false, {
        providerCode: input.code,
        rawLabel: input.rawLabel,
      });
      throw error;
    }
  }

  /** Kalıcı tarayıcı worker'ının kira/heartbeat durumu. */
  async screenWorkerState(actor: AdminActor, code: string): Promise<unknown> {
    const state = await this.backend.workerLeaseState(code);
    await this.audit(actor, "price.screen_worker", null, true, { providerCode: code, action: "worker_state" });
    return state;
  }

  /** Yönetici elle fiyat alımı tetikler. */
  async refreshPriceProvider(actor: AdminActor, code: string): Promise<unknown> {
    const { PriceIngestionService } = await import("@/server/prices/ingestion-service");
    const ingestion = new PriceIngestionService(this.backend, { now: () => this.now() });
    await ingestion.ensureCatalog();
    const outcome = await ingestion.ingestProvider(code);
    await this.audit(actor, "price.refresh", null, outcome.attempted, {
      providerCode: code,
      status: outcome.result?.status ?? "SKIPPED",
      accepted: outcome.accepted,
      quarantined: outcome.quarantined.length,
      safeErrorCode: outcome.safeErrorCode,
    });
    return {
      providerCode: outcome.providerCode,
      attempted: outcome.attempted,
      status: outcome.result?.status ?? "SKIPPED",
      accepted: outcome.accepted,
      quarantined: outcome.quarantined,
      safeErrorCode: outcome.safeErrorCode,
      message: outcome.message,
    };
  }

  /** Bağlantı testi: yalnızca durum ve güvenli hata kodu döner; secret DÖNMEZ. */
  async testPriceProvider(actor: AdminActor, code: string): Promise<unknown> {
    const { getProviderInstance } = await import("@/prices/registry");
    const provider = getProviderInstance(code);
    if (!provider) throw notFound("Fiyat kaynağı bulunamadı.");
    const health = await provider.healthCheck();
    await this.audit(actor, "price.provider_update", null, health.status === "ok", {
      providerCode: code,
      test: true,
      status: health.status,
      safeErrorCode: health.safeErrorCode,
    });
    return health;
  }

  /** MFA sıfırlaması için denetim kaydı (sıfırlamayı MfaService yapar). */
  async recordMfaReset(actor: AdminActor, targetUserId: string): Promise<void> {
    const target = await this.backend.getProfile(targetUserId);
    await this.audit(actor, "mfa.reset", target, true, { targetUserId });
  }

  async listUsers(actor: AdminActor, search?: string): Promise<UserProfile[]> {
    return this.backend.listProfiles({ search, limit: 200 });
  }

  async listAudit(actor: AdminActor, limit = 100): Promise<AdminAuditLog[]> {
    return this.backend.listAudit(limit);
  }

  async getUserDetail(actor: AdminActor, userId: string): Promise<UserProfile> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.view", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    await this.audit(actor, "user.view", target, true);
    return target;
  }

  /**
   * YÖNETİCİ KULLANICININ ALTIN VARLIĞINI GÖREMEZ.
   *
   * Ürün kararı (sahibi verdi): yönetici hesap yönetir, portföy okumaz.
   * Miktar, tutar, ortalama maliyet, kâr/zarar ve işlem geçmişi yönetici
   * yüzeyinden TAMAMEN kaldırıldı — ekranı gizlemek yetmez, veri sunucudan
   * hiç çıkmaz ve `/api/admin/users/[id]/portfolio` ucu silindi.
   *
   * Yönetici hesabın YAŞAM DÖNGÜSÜNÜ görmeye devam eder: son giriş zamanı,
   * açık oturumlar, cihaz etiketi. Destek için gereken budur.
   */
  async getUserAccount(actor: AdminActor, userId: string): Promise<{ user: UserProfile }> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.account_view", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    await this.audit(actor, "user.account_view", target, true, {});
    return { user: target };
  }

  async createUser(
    actor: AdminActor,
    input: { username: string; displayName: string; temporaryPassword: string },
  ): Promise<UserProfile> {
    const username = validateUsername(input.username ?? "");
    if (!username.ok) {
      await this.audit(actor, "user.create", null, false, { reason: "invalid_username" });
      throw badRequest(username.error ?? "Kullanıcı adı geçersiz.");
    }
    if (isReservedUsername(username.value)) {
      await this.audit(actor, "user.create", null, false, { reason: "reserved_username" });
      throw badRequest("Bu kullanıcı adı sistem tarafından ayrılmıştır.");
    }

    const displayName = (input.displayName ?? "").trim();
    if (displayName.length < 2 || displayName.length > 80) {
      await this.audit(actor, "user.create", null, false, { reason: "invalid_display_name" });
      throw badRequest("Görünen ad 2-80 karakter olmalıdır.");
    }

    const policy = validatePassword(input.temporaryPassword ?? "", username.value);
    if (!policy.ok) {
      await this.audit(actor, "user.create", null, false, { reason: "weak_password" });
      throw badRequest(policy.error ?? "Geçici parola politikaya uymuyor.");
    }

    const existing = await this.backend.findProfileByUsername(username.value);
    if (existing) {
      await this.audit(actor, "user.create", existing, false, { reason: "duplicate_username" });
      throw conflict("Bu kullanıcı adı zaten kullanılıyor.");
    }

    // Rol İSTEMCİDEN ALINMAZ. Panelden oluşturulan her hesap normal kullanıcıdır.
    const created = await this.backend.createUser({
      username: username.value,
      displayName,
      temporaryPassword: input.temporaryPassword,
      role: "user",
    });

    await this.audit(actor, "user.create", created, true, { mustChangePassword: true });
    return created;
  }

  async setUserStatus(
    actor: AdminActor,
    userId: string,
    status: UserStatus,
  ): Promise<UserProfile> {
    const action: AdminAction = status === "inactive" ? "user.deactivate" : "user.activate";

    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, action, null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    if (status === "inactive" && target.id === actor.profile.id) {
      await this.audit(actor, action, target, false, { reason: "self_deactivation" });
      throw badRequest("Kendi hesabınızı pasifleştiremezsiniz.");
    }
    if (status === "inactive" && target.role === "admin") {
      const admins = await this.backend.countAdmins();
      if (admins <= 1) {
        await this.audit(actor, action, target, false, { reason: "last_admin" });
        throw badRequest("Sistemdeki son aktif yönetici pasifleştirilemez.");
      }
    }

    const updated = await this.backend.setStatus(userId, status);
    if (status === "inactive") {
      // Mevcut erişim mümkün olan en kısa sürede kesilir.
      await this.backend.destroyAllSessionsForUser(userId);
    }
    await this.audit(actor, action, updated, true);
    return updated;
  }

  // ---------------------------------------------------------------- oturumlar

  /**
   * Kullanıcının aktif oturumları. Yalnızca güvenli metadata döner:
   * cihaz etiketi, oluşturulma, son görülme ve bitiş zamanı. Ham IP veya
   * User-Agent saklanmadığı için gösterilemez de.
   */
  async listUserSessions(actor: AdminActor, userId: string): Promise<SessionSummary[]> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.sessions_view", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    const rows = await this.backend.listSessionsForUser(userId, this.now());
    await this.audit(actor, "user.sessions_view", target, true, { sessionCount: rows.length });
    return rows.map((row) => ({ ...row, current: row.id === actor.sessionId }));
  }

  /** Kullanıcının TÜM oturumlarını kapatır; kullanıcı her cihazda yeniden giriş yapar. */
  async revokeUserSessions(
    actor: AdminActor,
    userId: string,
  ): Promise<{ closedSessions: number }> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.sessions_revoke", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    const closedSessions = await this.backend.destroyAllSessionsForUser(userId);
    await this.audit(actor, "user.sessions_revoke", target, true, {
      scope: "all",
      closedSessions,
    });
    return { closedSessions };
  }

  /** Kullanıcının belirli bir oturumunu kapatır. */
  async revokeUserSession(
    actor: AdminActor,
    userId: string,
    sessionId: string,
  ): Promise<{ closed: boolean }> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.sessions_revoke", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    const closed = await this.backend.destroySessionById(userId, sessionId);
    if (!closed) {
      await this.audit(actor, "user.sessions_revoke", target, false, {
        scope: "single",
        reason: "not_found",
      });
      throw notFound("Oturum bulunamadı.");
    }
    await this.audit(actor, "user.sessions_revoke", target, true, { scope: "single" });
    return { closed: true };
  }

  async resetUserPassword(
    actor: AdminActor,
    userId: string,
    temporaryPassword: string,
  ): Promise<UserProfile> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.password_reset", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }

    const policy = validatePassword(temporaryPassword ?? "", target.username);
    if (!policy.ok) {
      await this.audit(actor, "user.password_reset", target, false, { reason: "weak_password" });
      throw badRequest(policy.error ?? "Geçici parola politikaya uymuyor.");
    }

    await this.backend.setPassword(userId, temporaryPassword);
    const updated = await this.backend.setMustChangePassword(userId, true);
    // Parola sıfırlandığında tüm aktif oturumlar geçersiz olur.
    await this.backend.destroyAllSessionsForUser(userId);

    // Parola audit log'a YAZILMAZ.
    await this.audit(actor, "user.password_reset", updated, true, { mustChangePassword: true });
    return updated;
  }

  /**
   * Kalıcı silme. Varsayılan yönetim işlemi DEĞİLDİR; pasifleştirme tercih edilir.
   * Silme için hedefin kullanıcı adının birebir yazılması zorunludur.
   *
   * Denetim kaydı dürüsttür: girişim, sonuç ve hata ayrı ayrı yazılır.
   */
  async deleteUser(
    actor: AdminActor,
    userId: string,
    confirmationUsername: string,
  ): Promise<DeleteUserResult> {
    const target = await this.backend.getProfile(userId);
    if (!target) {
      await this.audit(actor, "user.delete_attempt", null, false, { userId });
      throw notFound("Kullanıcı bulunamadı.");
    }
    if (target.id === actor.profile.id) {
      await this.audit(actor, "user.delete_attempt", target, false, { reason: "self_delete" });
      throw badRequest("Kendi hesabınızı silemezsiniz.");
    }

    const confirmation = validateUsername(confirmationUsername ?? "");
    if (!confirmation.ok || confirmation.value !== target.username) {
      await this.audit(actor, "user.delete_attempt", target, false, {
        reason: "confirmation_mismatch",
      });
      throw badRequest(
        "Silme onayı eşleşmedi. Kalıcı silme için kullanıcı adını birebir yazmalısınız.",
      );
    }

    if (target.role === "admin") {
      const admins = await this.backend.countAdmins();
      if (admins <= 1) {
        await this.audit(actor, "user.delete_attempt", target, false, { reason: "last_admin" });
        throw badRequest("Sistemdeki son aktif yönetici silinemez.");
      }
    }

    await this.audit(actor, "user.delete_attempt", target, true, { confirmed: true });

    try {
      await this.backend.destroyAllSessionsForUser(userId);
      await this.backend.deleteUser(userId);
    } catch (error) {
      // Başarısız silme de dürüstçe kaydedilir.
      await this.audit(actor, "user.delete", target, false, {
        reason: "backend_error",
      });
      throw error;
    }

    const auditWritten = await this.audit(actor, "user.delete", target, true, {
      cascade: "portfolio_and_transactions",
    });

    return { deleted: true, auditWriteFailed: !auditWritten };
  }
}
