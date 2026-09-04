import type { AdminAuditLog, UserProfile, UserRole, UserStatus } from "@/auth/types";
import type {
  LedgerAppendRequest,
  LedgerAppendResult,
  LedgerEntry,
  LedgerReplaceResult,
  LedgerVoidResult,
  ProductPosition,
} from "@/domain/accounting/types";
import type { PortfolioMeta } from "@/domain/types";
import type {
  IngestionPayload,
  IngestionResult,
  PricePreferenceResult,
  PricePreferenceRow,
  PriceSourceEventRow,
  ProviderQuotesRow,
  ProviderStateRow,
  ProviderSyncInput,
  QuarantineRow,
  ScreenRawRow,
  ScreenRowsSnapshot,
  ExperimentalAccessRow,
  MappingApprovalRow,
  WorkerLeaseState,
  PriceHistoryRow,
} from "@/server/prices/types";
import type { DataScope } from "./actor";

export type { LedgerAppendResult, LedgerReplaceResult, LedgerVoidResult };

/**
 * Kimlik doğrulama + veri arka ucu sözleşmesi.
 *
 * İki uygulaması vardır:
 *  - SupabaseAuthBackend : üretim. Parolalar Supabase Auth'ta tutulur.
 *  - LocalAuthBackend    : YALNIZCA geliştirme/test. Üretim derlemesinde çalışmaz.
 *
 * YETKİLENDİRME SINIRI
 * Kullanıcıya ait veri metotları ham `userId: string` DEĞİL, markalanmış
 * `DataScope` alır. `DataScope` yalnızca `ownScope()` (kendi verisi) veya
 * `adminScope()` (yönetici, hedef kullanıcı) ile üretilebilir. Böylece bir
 * route gövdeden gelen kimlikle veri metodunu çağıramaz — bu derleme hatasıdır.
 *
 * Yetkilendirme, denetim kaydı ve iş kuralları arka uçta DEĞİL, servis
 * katmanında (AuthService / AdminService / UserPortfolioService) uygulanır.
 *
 * İŞLEM DEFTERİ KAYNAK GERÇEKTİR
 * Finansal veri yalnızca eklenir (append) ya da durumu değişir (VOID/REPLACED);
 * hard delete yoktur. Pozisyonlar defterden yeniden oynatılarak türetilir.
 */

export interface CreateUserRequest {
  username: string;
  displayName: string;
  temporaryPassword: string;
  role: UserRole;
}

/** Oturum ömür politikası (giriş anında belirlenir, oturum kaydına yazılır). */
export interface SessionPolicy {
  /** true: kalıcı çerez + 180 gün kaydırmalı ömür. false: tarayıcı oturumu çerezi. */
  persistent: boolean;
  /** Kalıcı olmayan oturumda hareketsizlik sınırı (ms). Kalıcıda null. */
  idleTimeoutMs: number | null;
  /** Mutlak ömür (ms). Kalıcıda kaydırmalı ömür, kalıcı olmayanda sabit üst sınır. */
  absoluteLifetimeMs: number;
}

/** Yeni oluşturulan oturum. `token` yalnızca çereze yazılır; sunucuda özeti saklanır. */
export interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  deviceLabel: string;
  persistent: boolean;
}

/** Çözülmüş oturum: profil ve süre bilgileri. */
export interface ResolvedSession {
  sessionId: string;
  profile: UserProfile;
  /** Etkin bitiş zamanı (ISO): kalıcıda kaydırmalı, kalıcı olmayanda mutlak. */
  expiresAt: string;
  /** Kalıcı olmayan oturumda hareketsizlik bitişi; kalıcıda null. */
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
  persistent: boolean;
  /** Bu oturumda ikinci faktörün doğrulandığı an (admin oturumlarında zorunlu). */
  mfaVerifiedAt: string | null;
  lastSeenAt: string;
  /** Bitiş zamanının en son ileri alındığı an. */
  renewedAt: string;
  /** Oturum kimliğinin en son yenilendiği an. */
  rotatedAt: string;
  createdAt: string;
  deviceLabel: string;
}

/** touchSession ile yazılan alanlar. Verilmeyen alan değişmez. */
export interface SessionTouch {
  lastSeenAt: string;
  expiresAt?: string;
  renewedAt?: string;
  idleExpiresAt?: string;
}

/** Yönetici ve kullanıcı ekranları için güvenli oturum özeti (ham IP / UA YOK). */
export interface StoredSessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  deviceLabel: string;
  persistent: boolean;
}

/** Portföy provisioning eksik. GET yolu veri oluşturmaz; onarım gerekir. */
export class PortfolioNotProvisionedError extends Error {
  constructor(readonly userId: string) {
    super("Portföy kaydı hazırlanmamış.");
    this.name = "PortfolioNotProvisionedError";
  }
}

/** Aşırı satış (oversell) girişimi. Servis katmanı bunu 400'e çevirir. */
export class OversellError extends Error {
  constructor(
    readonly productId: string,
    readonly available: string,
  ) {
    super("Satış miktarı elinizdeki miktarı aşamaz.");
    this.name = "OversellError";
  }
}

/** Aynı idempotency anahtarı farklı içerikle geldi. Servis katmanı 409'a çevirir. */
export class IdempotencyConflictError extends Error {
  constructor(readonly clientRequestId: string) {
    super("Aynı istek kimliği farklı bir işlem içeriğiyle daha önce kullanılmış.");
    this.name = "IdempotencyConflictError";
  }
}

/** Kayıt bulunamadı ya da bu kapsamda değil. Servis katmanı 404'e çevirir. */
export class LedgerEntryNotFoundError extends Error {
  constructor(readonly entryId: string) {
    super("İşlem bulunamadı.");
    this.name = "LedgerEntryNotFoundError";
  }
}

/** Yalnızca AKTİF kayıt iptal edilebilir / düzeltilebilir. Servis 409'a çevirir. */
export class LedgerEntryNotActiveError extends Error {
  constructor(readonly entryId: string) {
    super("Bu işlem zaten iptal edilmiş veya düzeltilmiş.");
    this.name = "LedgerEntryNotActiveError";
  }
}

export interface LedgerVerifyResult {
  checked: number;
  mismatches: {
    productId: string;
    field: string;
    stored: string | null;
    recomputed: string | null;
  }[];
}

export type {
  IngestionPayload,
  IngestionResult,
  PricePreferenceResult,
  PricePreferenceRow,
  PriceSourceEventRow,
  ProviderQuotesRow,
  ProviderStateRow,
  ProviderSyncInput,
  ScreenRawRow,
  ScreenRowsSnapshot,
};
export { ProviderNotSelectableError } from "@/server/prices/types";

/** Yönetici TOTP kimlik bilgisi. Secret ŞİFRELİ saklanır; düz metin dönmez. */
export interface MfaCredentialRecord {
  userId: string;
  secretCiphertext: string;
  secretNonce: string;
  confirmedAt: string | null;
  lastVerifiedAt: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  /** Başarıyla kullanılmış son TOTP zaman adımı (replay koruması). */
  lastUsedCounter: number | null;
}

/** Defter sürümü: yalnızca gerçek değişiklikte artan sinyal (işlem sayısı değil). */
export interface LedgerRevision {
  revision: number;
  updatedAt: string;
}

export interface AuthBackend {
  readonly id: "supabase" | "local";
  readonly label: string;
  /** Veriler sunucuda kalıcı mı ve cihazlar arasında paylaşılıyor mu? */
  readonly syncsAcrossDevices: boolean;

  /** Arka ucun kullanılabilir olduğunu doğrular; değilse Türkçe hata fırlatır. */
  ensureReady(): Promise<void>;

  // --- Kimlik doğrulama ---
  /** Parolayı doğrular. Kullanıcı yoksa da parola yanlışsa da null döner. */
  verifyCredentials(username: string, password: string): Promise<UserProfile | null>;
  /** Kullanıcının mevcut parolasını doğrular (parola değiştirme akışı için). */
  verifyPasswordForUser(userId: string, password: string): Promise<boolean>;
  setPassword(userId: string, newPassword: string): Promise<void>;

  // --- Oturum ---
  createSession(
    userId: string,
    now: number,
    deviceLabel: string,
    policy: SessionPolicy,
  ): Promise<SessionRecord>;
  /**
   * Jetonu çözer. Süresi geçen (hareketsizlik veya mutlak), iptal edilen veya
   * sahibi pasif olan oturum reddedilir. Yakın zamanda yenilenmiş kimliğin
   * ESKİ hâli, kısa bir tolerans süresi boyunca kabul edilir.
   */
  resolveSession(token: string, now: number): Promise<ResolvedSession | null>;
  /** last_seen / bitiş zamanlarını yazar. Çağıran taraf sıklığı sınırlar. */
  touchSession(sessionId: string, patch: SessionTouch): Promise<void>;
  /**
   * Oturum kimliğini yeniler: yeni jeton üretir, eski jetonu `graceMs`
   * boyunca geçerli tutar. Oturum yoksa/iptalse null döner.
   */
  rotateSession(sessionId: string, now: number, graceMs: number): Promise<string | null>;
  /** Yalnızca bu cihazın oturumunu kapatır. */
  destroySession(token: string): Promise<void>;
  /** Belirli bir oturumu kimliğiyle kapatır (kullanıcı eşleşmiyorsa false). */
  destroySessionById(userId: string, sessionId: string): Promise<boolean>;
  /**
   * Kullanıcının tüm oturumlarını düşürür. `exceptSessionId` verilirse o oturum
   * korunur (kullanıcının kendi parola değişikliği). Kapatılan sayıyı döner.
   */
  destroyAllSessionsForUser(userId: string, options?: { exceptSessionId?: string }): Promise<number>;
  /** Kullanıcının aktif oturumlarını listeler (güvenli metadata ile). */
  listSessionsForUser(userId: string, now: number): Promise<StoredSessionSummary[]>;
  /** Süresi geçmiş / iptal edilmiş oturumları temizler. Silinen kayıt adedini döner. */
  purgeExpiredSessions(now: number): Promise<number>;

  // --- Profiller ---
  getProfile(userId: string): Promise<UserProfile | null>;
  findProfileByUsername(username: string): Promise<UserProfile | null>;
  listProfiles(options?: { search?: string; limit?: number }): Promise<UserProfile[]>;
  countAdmins(): Promise<number>;
  createUser(request: CreateUserRequest): Promise<UserProfile>;
  setStatus(userId: string, status: UserStatus): Promise<UserProfile>;
  setMustChangePassword(userId: string, value: boolean): Promise<UserProfile>;
  recordLogin(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // --- Denetim kaydı ---
  appendAudit(entry: Omit<AdminAuditLog, "id" | "createdAt">): Promise<AdminAuditLog>;
  listAudit(limit?: number): Promise<AdminAuditLog[]>;

  // --- Provisioning ---
  /**
   * Profili olup portföyü/tercihi olmayan kullanıcıları tamamlar (idempotent).
   * Yalnızca yönetim yolundan çağrılır. Onarılan kullanıcı sayısını döner.
   */
  provisionMissingDefaults(): Promise<number>;

  // --- Portföy (DataScope ile korunur) ---
  /**
   * Portföyü OKUR; yoksa PortfolioNotProvisionedError fırlatır.
   * Bu metot hiçbir koşulda veri OLUŞTURMAZ.
   */
  getPortfolio(scope: DataScope): Promise<PortfolioMeta>;
  updatePortfolio(
    scope: DataScope,
    patch: { name?: string; displayName?: string },
  ): Promise<PortfolioMeta>;

  // --- İşlem defteri (append-only; hard delete YOK) ---
  /** Bütün kayıtlar (ACTIVE, VOID, REPLACED). Salt okuma; hiçbir şey yazmaz. */
  listLedger(scope: DataScope): Promise<LedgerEntry[]>;
  /** Türetilmiş pozisyonlar. Salt okuma; hiçbir şey yazmaz. */
  listPositions(scope: DataScope): Promise<ProductPosition[]>;
  /**
   * Yeni defter kaydı ekler; pozisyonu aynı işlem içinde atomik olarak yeniden
   * oluşturur; negatif miktarı engeller; idempotency anahtarını uygular.
   */
  appendLedgerEntry(scope: DataScope, request: LedgerAppendRequest): Promise<LedgerAppendResult>;
  /** Kaydı VOID yapar (hard delete yok); sonraki satış negatife düşerse reddeder. */
  voidLedgerEntry(scope: DataScope, entryId: string, reason: string): Promise<LedgerVoidResult>;
  /** Kaydı REPLACED yapar ve yerine yeni kayıt ekler; tek işlem. */
  replaceLedgerEntry(
    scope: DataScope,
    entryId: string,
    request: LedgerAppendRequest,
  ): Promise<LedgerReplaceResult>;
  /** Tüm aktif kayıtları VOID yapar. Döndürülen sayı iptal edilen kayıt adedidir. */
  voidAllLedgerEntries(scope: DataScope, reason: string): Promise<number>;
  /** Defteri yeniden oynatıp türetilmiş pozisyonlarla karşılaştırır. */
  verifyLedger(scope: DataScope): Promise<LedgerVerifyResult>;
  /** Kullanıcının defter sürümü (cihazlar arası senkronizasyon sinyali). Salt okuma. */
  getLedgerRevision(scope: DataScope): Promise<LedgerRevision>;

  // --- Fiyat kaynakları (Sprint 3) ---
  /** Sağlayıcı kataloğunu koddaki tanımlarla eşitler (idempotent). */
  syncPriceProviders(providers: readonly ProviderSyncInput[]): Promise<number>;
  /** Sembol → kanonik ürün eşlemelerini eşitler. */
  syncPriceMappings(code: string, mappingVersion: string, mapping: Record<string, string>): Promise<number>;
  /** Sağlayıcı listesi + sağlık + son koşum (yönetici ekranı). */
  listPriceProviders(): Promise<ProviderStateRow[]>;
  /** Yönetici: kaynağı etkinleştir / kullanıcıya aç. Lisanssızsa reddedilir. */
  setPriceProviderFlags(code: string, enabled: boolean, userSelectable: boolean): Promise<ProviderStateRow>;
  /** Fiyat alımını uygular (atomik, kilitli, idempotent). */
  applyPriceIngestion(code: string, runKey: string, payload: IngestionPayload): Promise<IngestionResult>;

  /**
   * Ekranda görünen BÜTÜN ham satırları saklar.
   *
   * Hiçbir fiyat kabul edilmese bile yazılır: "Kayseri Fiyatları" ekranının
   * asıl gerekli olduğu durum tam olarak budur.
   */
  setScreenRows(code: string, rows: readonly ScreenRawRow[], signature: string, observedAt: string): Promise<void>;

  /** Saklanan son ham satır kümesi. */
  screenRows(code: string): Promise<ScreenRowsSnapshot | null>;

  /**
   * Yedek için tek bir tabloyu dışa aktarır.
   *
   * Yalnız izin verilen tablolar okunabilir; parola hash'i, MFA secret'ı,
   * oturum ve token sütunları çağıran tarafından DEĞİL, veritabanı
   * fonksiyonunun kendisi tarafından dışarıda bırakılır.
   */
  exportBackupTable(table: string): Promise<unknown[]>;
  /** Bir sağlayıcının güncel fiyatları. */
  currentPriceQuotes(code: string): Promise<ProviderQuotesRow | null>;
  /** Birden çok sağlayıcının fiyatları (karşılaştırma ekranı). */
  comparePriceQuotes(codes: readonly string[]): Promise<ProviderQuotesRow[]>;
  /**
   * Fiyat GEÇMİŞİ (append-only kayıt). Grafik bunu kullanır.
   * Kullanıcıya değil sağlayıcıya ait veridir; kapsam filtresi yoktur.
   */
  priceQuoteHistory(
    codes: readonly string[],
    sinceIso: string,
    limit?: number,
  ): Promise<PriceHistoryRow[]>;
  /** Portföyün seçili fiyat kaynağı. */
  getPricePreference(scope: DataScope): Promise<PricePreferenceRow>;
  /** Portföyün fiyat kaynağını değiştirir; denetim olayı üretir. */
  setPricePreference(
    scope: DataScope,
    code: string,
    actorId: string,
    role: "user" | "admin",
    reason: string,
  ): Promise<PricePreferenceResult>;
  /** Kaynak değişim geçmişi. */
  /** Karantinaya alınmış fiyat kayıtları (yalnızca yönetim; salt okunur). */
  listPriceQuarantine(code: string | null, limit?: number): Promise<QuarantineRow[]>;
  /** Açık global varsayılan kaynağı belirler; null hepsini temizler. */
  setDefaultPriceProvider(code: string | null): Promise<string | null>;
  /** Açık global varsayılan kaynak (yoksa null). */
  defaultPriceProvider(): Promise<string | null>;

  // --- Deneysel özel pilot (Sprint 3.2) ---
  /** Yönetici, bir kullanıcının portföyüne deneysel kaynak erişimi verir/kaldırır. */
  setExperimentalAccess(
    userId: string,
    code: string,
    enabled: boolean,
    adminId: string,
    reason: string,
    expiresAt: string | null,
  ): Promise<void>;
  /** Bu kullanıcının portföyü deneysel kaynağı kullanabilir mi? */
  experimentalAccessAllowed(userId: string, code: string): Promise<boolean>;
  /** İzin listesi (yalnızca yönetim). */
  listExperimentalAccess(code: string): Promise<ExperimentalAccessRow[]>;
  /** Yönetici ekran eşlemesini onaylar veya geri alır. */
  approvePriceMapping(input: {
    code: string;
    rawLabel: string;
    canonicalProductId: string;
    mappingVersion: string;
    adminId: string;
    evidenceLiquidation: string | null;
    evidenceReplacement: string | null;
    evidenceObservedAt: string | null;
    revoke: boolean;
  }): Promise<void>;
  /** Etkin eşleme onayları. */
  listMappingApprovals(code: string): Promise<MappingApprovalRow[]>;
  /** Worker nonce'unu tek kullanımlık talep eder; tekrar gönderilirse false. */
  claimWorkerNonce(nonce: string, workerId: string): Promise<boolean>;
  /** Aynı sağlayıcı için tek worker garantisi. */
  acquireWorkerLease(
    code: string,
    workerId: string,
    ttlSeconds: number,
  ): Promise<{ held: boolean; workerId: string; takeover: boolean }>;
  /** Kira durumu (yönetim ekranı). */
  workerLeaseState(code: string): Promise<WorkerLeaseState | null>;
  listPriceSourceEvents(scope: DataScope, limit?: number): Promise<PriceSourceEventRow[]>;

  // --- Yönetici ikinci faktörü (Sprint 3) ---
  /** Kayıtlı TOTP kimlik bilgisi (şifreli secret). Yoksa null. */
  getMfaCredential(userId: string): Promise<MfaCredentialRecord | null>;
  /** Yeni (henüz doğrulanmamış) TOTP secret'ını şifreli olarak kaydeder. */
  saveMfaCredential(userId: string, secret: { ciphertext: string; nonce: string }): Promise<void>;
  /** İlk doğru kodla kaydı onaylar. */
  confirmMfaCredential(userId: string, at: string): Promise<void>;
  /** MFA kaydını ve kurtarma kodlarını siler (yalnızca açık onaylı sıfırlama). */
  deleteMfaCredential(userId: string): Promise<void>;
  /** Başarılı/başarısız doğrulama sayaçlarını günceller. */
  recordMfaAttempt(userId: string, success: boolean, at: string): Promise<MfaCredentialRecord | null>;
  /**
   * TOTP zaman adımını ATOMİK olarak talep eder.
   *
   * `true` yalnızca sayaç daha önce kullanılmamışsa döner. Aynı kodu gönderen
   * ikinci (eşzamanlı) istek `false` alır ve doğrulanamaz.
   */
  claimMfaCounter(userId: string, counter: number): Promise<boolean>;
  /** Kurtarma kodlarını (yalnızca özet) yazar; eski kodları geçersiz kılar. */
  replaceRecoveryCodes(userId: string, hashes: readonly string[]): Promise<void>;
  /** Kurtarma kodunu tek kullanımlık olarak harcar. */
  consumeRecoveryCode(userId: string, hash: string, at: string): Promise<boolean>;
  /** Kullanılmamış kurtarma kodu sayısı. */
  countRecoveryCodes(userId: string): Promise<number>;
  /** Oturumu "ikinci faktör doğrulandı" olarak işaretler. */
  markSessionMfaVerified(sessionId: string, at: string): Promise<void>;
}
