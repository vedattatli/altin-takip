import "server-only";

import { appConfig } from "@/config/app.config";
import type { UserProfile } from "@/auth/types";
import type { AdminActor, UserActor } from "./actor";
import type { AuthBackend } from "./backend";
import { badRequest, conflict, forbidden, misconfigured, tooManyRequests } from "./errors";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hasMfaEncryptionKey,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp";

/**
 * YÖNETİCİ İKİNCİ FAKTÖRÜ (TOTP)
 *
 * Yönetici bütün kullanıcıların uygulamaya kaydettiği portföyleri görebildiği için
 * admin hesaplarında MFA ZORUNLUDUR. Normal kullanıcı için zorunlu değildir.
 *
 * - Secret ve kurtarma kodları yalnızca KAYIT anında bir kez gösterilir; sonra
 *   yalnızca şifreli/özetlenmiş hâlleri saklanır ve hiçbir log'a yazılmaz.
 * - Doğrulama yapılmadan admin paneli ve admin API'leri çalışmaz.
 * - Parola değişikliği MFA'yı sessizce KALDIRMAZ.
 * - MFA sıfırlama ayrı denetim kaydı ve açık onay ister.
 */

export type MfaState = "not_required" | "not_enrolled" | "pending_confirmation" | "enrolled";

export interface MfaStatusView {
  required: boolean;
  state: MfaState;
  /** Bu oturumda ikinci faktör doğrulandı mı? */
  sessionVerified: boolean;
  remainingRecoveryCodes: number;
  /** Şifreleme anahtarı yoksa MFA kullanılamaz; yönetici bunu görmelidir. */
  configured: boolean;
}

export interface EnrollmentResult {
  /** Yalnızca bu yanıtta döner; tekrar gösterilmez. */
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

const MAX_FAILED_ATTEMPTS = 5;

export class MfaService {
  constructor(
    private readonly backend: AuthBackend,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Bu rol için ikinci faktör zorunlu mu? */
  static isRequiredFor(profile: UserProfile): boolean {
    return profile.role === "admin";
  }

  private assertConfigured(): void {
    if (!hasMfaEncryptionKey()) {
      throw misconfigured(
        "AUTH_MFA_ENCRYPTION_KEY tanımlı değil. Yönetici ikinci faktörü bu anahtar olmadan kullanılamaz.",
      );
    }
  }

  async status(profile: UserProfile, sessionMfaVerifiedAt: string | null): Promise<MfaStatusView> {
    const required = MfaService.isRequiredFor(profile);
    const credential = await this.backend.getMfaCredential(profile.id);
    const state: MfaState = !required
      ? "not_required"
      : !credential
        ? "not_enrolled"
        : credential.confirmedAt
          ? "enrolled"
          : "pending_confirmation";
    return {
      required,
      state,
      sessionVerified: Boolean(sessionMfaVerifiedAt),
      remainingRecoveryCodes: credential ? await this.backend.countRecoveryCodes(profile.id) : 0,
      configured: hasMfaEncryptionKey(),
    };
  }

  /**
   * Kayıt başlatır: yeni secret ve kurtarma kodları üretir.
   * Secret ve kodlar YALNIZCA bu yanıtta döner. Zaten onaylı bir kayıt varsa
   * yeniden kayıt için önce sıfırlama (açık onay) gerekir.
   */
  async startEnrollment(actor: UserActor | AdminActor, accountName: string): Promise<EnrollmentResult> {
    this.assertConfigured();
    const existing = await this.backend.getMfaCredential(actor.profile.id);
    if (existing?.confirmedAt) {
      throw conflict("İkinci faktör zaten kurulu. Yeniden kurmak için önce sıfırlama gerekir.");
    }
    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret);
    await this.backend.saveMfaCredential(actor.profile.id, encrypted);
    const { codes, hashes } = generateRecoveryCodes();
    await this.backend.replaceRecoveryCodes(actor.profile.id, hashes);
    return {
      secret,
      otpauthUri: otpauthUri(secret, accountName, appConfig.name),
      recoveryCodes: codes,
    };
  }

  /** İlk doğru kodla kaydı tamamlar ve oturumu doğrulanmış işaretler. */
  async confirmEnrollment(actor: UserActor | AdminActor, code: unknown): Promise<void> {
    this.assertConfigured();
    const credential = await this.backend.getMfaCredential(actor.profile.id);
    if (!credential) throw badRequest("Önce ikinci faktör kurulumunu başlatın.");
    if (credential.confirmedAt) throw conflict("İkinci faktör zaten onaylanmış.");
    if (typeof code !== "string" || !verifyTotp(decryptSecret({ ciphertext: credential.secretCiphertext, nonce: credential.secretNonce }), code, this.now())) {
      await this.backend.recordMfaAttempt(actor.profile.id, false, new Date(this.now()).toISOString());
      throw badRequest("Kod doğrulanamadı. Uygulamanızdaki güncel kodu girin.");
    }
    const at = new Date(this.now()).toISOString();
    await this.backend.confirmMfaCredential(actor.profile.id, at);
    await this.backend.markSessionMfaVerified(actor.sessionId, at);
  }

  /**
   * Oturum için ikinci faktörü doğrular. TOTP kodu veya kurtarma kodu kabul edilir.
   * Art arda hatalı denemede hesap geçici olarak kilitlenir.
   */
  async verify(actor: UserActor | AdminActor, code: unknown): Promise<{ usedRecoveryCode: boolean }> {
    this.assertConfigured();
    const credential = await this.backend.getMfaCredential(actor.profile.id);
    if (!credential || !credential.confirmedAt) {
      throw badRequest("İkinci faktör kurulu değil.");
    }
    const now = this.now();
    if (credential.lockedUntil && Date.parse(credential.lockedUntil) > now) {
      throw tooManyRequests(
        "Çok fazla hatalı deneme yapıldı. Lütfen bir süre sonra tekrar deneyin.",
        Date.parse(credential.lockedUntil) - now,
      );
    }
    if (typeof code !== "string" || code.trim() === "") {
      throw badRequest("Doğrulama kodu gerekli.");
    }

    const at = new Date(now).toISOString();
    const secret = decryptSecret({ ciphertext: credential.secretCiphertext, nonce: credential.secretNonce });
    if (verifyTotp(secret, code, now)) {
      await this.backend.recordMfaAttempt(actor.profile.id, true, at);
      await this.backend.markSessionMfaVerified(actor.sessionId, at);
      return { usedRecoveryCode: false };
    }

    // Kurtarma kodu tek kullanımlıktır.
    const consumed = await this.backend.consumeRecoveryCode(actor.profile.id, hashRecoveryCode(code), at);
    if (consumed) {
      await this.backend.recordMfaAttempt(actor.profile.id, true, at);
      await this.backend.markSessionMfaVerified(actor.sessionId, at);
      return { usedRecoveryCode: true };
    }

    const updated = await this.backend.recordMfaAttempt(actor.profile.id, false, at);
    if (updated && updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      throw tooManyRequests("Çok fazla hatalı deneme yapıldı. Lütfen bir süre sonra tekrar deneyin.", 15 * 60_000);
    }
    throw badRequest("Kod doğrulanamadı.");
  }

  /**
   * Yönetici sıfırlaması: hedefin MFA kaydını siler ve bütün oturumlarını kapatır.
   * Açık onay (kullanıcı adının birebir yazılması) ve denetim kaydı zorunludur.
   */
  async resetForUser(admin: AdminActor, targetUserId: string, confirmation: unknown): Promise<void> {
    const target = await this.backend.getProfile(targetUserId);
    if (!target) throw badRequest("Kullanıcı bulunamadı.");
    if (typeof confirmation !== "string" || confirmation.trim().toLowerCase() !== target.username.toLowerCase()) {
      throw badRequest("Onaylamak için kullanıcı adını birebir yazın.");
    }
    if (target.id === admin.profile.id) {
      throw badRequest("Kendi ikinci faktörünüzü bu ekrandan sıfırlayamazsınız.");
    }
    await this.backend.deleteMfaCredential(target.id);
    // Sıfırlama sonrası hedefin bütün oturumları kapatılır (yeniden kurulum zorunlu).
    await this.backend.destroyAllSessionsForUser(target.id);
  }

  /** Yöneticinin admin uçlarına erişmesi için oturumda MFA doğrulanmış olmalıdır. */
  async assertSessionSatisfiesMfa(profile: UserProfile, sessionMfaVerifiedAt: string | null): Promise<void> {
    if (!MfaService.isRequiredFor(profile)) return;
    if (!hasMfaEncryptionKey()) {
      throw misconfigured(
        "AUTH_MFA_ENCRYPTION_KEY tanımlı değil. Yönetici işlemleri ikinci faktör olmadan çalıştırılamaz.",
      );
    }
    const credential = await this.backend.getMfaCredential(profile.id);
    if (!credential || !credential.confirmedAt) {
      throw forbidden("Yönetici hesabında ikinci faktör kurulumu tamamlanmadan yönetim işlemleri yapılamaz.");
    }
    if (!sessionMfaVerifiedAt) {
      throw forbidden("Bu oturumda ikinci faktör doğrulanmadı.");
    }
  }
}
