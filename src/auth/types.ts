/**
 * KALICI OTURUM MODELİ
 *
 * Bütün cihazlarda aynı, sade ve kalıcı oturum kullanılır:
 *  - Tarayıcıda yalnızca rastgele, opak bir oturum kimliği (HttpOnly çerez) bulunur.
 *  - Oturum "kaydırmalı" (rolling) ömürlüdür: kullanıcı aktif oldukça bitiş
 *    zamanı sessizce ileri taşınır; süresiz aktif kullanım mümkündür.
 *  - Oturum kimliği belirli aralıklarla sessizce yenilenir (rotation); hiç
 *    bitmeyen ve hiç değişmeyen jeton yoktur.
 *  - Hareketsizlik zaman aşımı, cihaz türü seçimi veya otomatik çıkış YOKTUR.
 *  - Oturum yalnızca kullanıcının açık çıkışıyla ya da güvenlik olaylarıyla
 *    (parola sıfırlama, pasifleştirme, yönetici iptali, hesap silme) kapanır.
 */

/** Kaydırmalı oturum ömrü: son yenilemeden itibaren 180 gün. */
export const SESSION_ROLLING_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Bitiş zamanı bu aralıktan sık ileri alınmaz. Her istekte veritabanına yazmak
 * gereksizdir; 24 saatte bir yenileme 180 günlük ömür için fazlasıyla yeterlidir.
 */
export const SESSION_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** last_seen_at bu aralıktan sık yazılmaz (yönetici oturum listesi için kaba bilgi). */
export const SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

/** Oturum kimliği bu aralıkla sessizce yenilenir; kullanıcı fark etmez. */
export const SESSION_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Yenilemeden hemen sonra eski kimlik kısa bir süre daha kabul edilir; böylece
 * aynı anda uçuşta olan istekler (paralel API çağrıları) düşmez.
 */
export const SESSION_ROTATION_GRACE_MS = 60 * 1000;

/** Yönetici / kullanıcı ekranlarında gösterilen güvenli oturum özeti. */
export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Kaba, kullanıcı dostu tanım (örn. "Chrome · Windows"). Ham User-Agent SAKLANMAZ. */
  deviceLabel: string;
  /** İsteği yapan oturumun kendisi mi? */
  current: boolean;
}

/**
 * Test kaçış kapısı belirteci.
 *
 * Yalnızca otomatik testler için vardır ve kazara açılamasın diye bilinçli olarak
 * tahmin edilmesi zor bir değerdir. Üretim dağıtımlarında ASLA ayarlanmaz.
 */
export const TEST_OVERRIDE_TOKEN = "yalnizca-test-icin";

/** Roller. Rol yalnızca sunucu tarafında atanır; kullanıcı kendi rolünü değiştiremez. */
export type UserRole = "admin" | "user";

/** Hesap durumu. Pasif kullanıcı giriş yapamaz ve mevcut oturumu geçersiz olur. */
export type UserStatus = "active" | "inactive";

export interface UserProfile {
  id: string;
  /** Normalize edilmiş, benzersiz kullanıcı adı. */
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  /** true ise kullanıcı parola değiştirene kadar uygulamayı kullanamaz. */
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** İstemciye gönderilen güvenli oturum bilgisi. Dahili e-posta ASLA yer almaz. */
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export function toSessionUser(profile: UserProfile): SessionUser {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    role: profile.role,
    mustChangePassword: profile.mustChangePassword,
  };
}

/** Admin panelinde yapılabilecek işlemler. Audit log'da da bu adlar kullanılır. */
export type AdminAction =
  | "user.create"
  | "user.deactivate"
  | "user.activate"
  | "user.password_reset"
  | "user.view"
  | "user.portfolio_view"
  | "user.sessions_view"
  | "user.sessions_revoke"
  | "user.delete_attempt"
  | "user.delete";

export interface AdminAuditLog {
  id: string;
  adminUserId: string;
  adminUsername: string;
  targetUserId: string | null;
  targetUsername: string | null;
  action: AdminAction;
  /** true = işlem başarılı, false = reddedildi/başarısız. */
  success: boolean;
  /** Hassas veri İÇERMEZ: parola, tutar veya işlem detayı yazılmaz. */
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

/**
 * Adminin kullanıcı adına finansal kayıt DÜZENLEYEBİLMESİ ayrı bir yetkidir.
 * İlk sürümde varsayılan olarak KAPALIDIR: admin yalnızca görüntüler.
 */
export const ADMIN_CAN_EDIT_USER_PORTFOLIO = false;

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Yönetici",
  user: "Kullanıcı",
};

export const STATUS_LABELS: Record<UserStatus, string> = {
  active: "Aktif",
  inactive: "Pasif",
};
