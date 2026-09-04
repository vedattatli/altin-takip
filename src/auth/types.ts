/**
 * OTURUM MODELİ — kullanıcı tercihine bağlı
 *
 * Tarayıcıda yalnızca rastgele, opak bir oturum kimliği (HttpOnly çerez) bulunur.
 *
 *  A. "Bu cihazda oturumumu açık tut" İŞARETLİ (persistent):
 *     - kalıcı çerez, 180 gün kaydırmalı ömür (bitiş ≤ 24 saatte bir ileri alınır),
 *     - kimlik 7 günde bir sessizce yenilenir (60 sn tolerans),
 *     - yalnızca açık çıkış veya güvenlik olayıyla kapanır.
 *  B. İŞARETSİZ (tarayıcı oturumu):
 *     - tarayıcı oturumu çerezi (kapanınca silinir),
 *     - sunucuda en fazla 8 saat mutlak ömür ve 30 dakika hareketsizlik.
 *  C. ADMIN hesapları: tercihten bağımsız en fazla 8 saat mutlak, 15 dakika
 *     hareketsizlik; asla kalıcı değil.
 *
 * Tercih localStorage/sessionStorage'a yazılmaz; oturum kaydında (persistent) tutulur.
 */

/** Kalıcı oturum: kaydırmalı ömür, son yenilemeden itibaren 180 gün. */
export const SESSION_ROLLING_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/** Tarayıcı oturumu (tercih işaretsiz): mutlak üst sınır 8 saat. */
export const BROWSER_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
/** Tarayıcı oturumu: hareketsizlik sınırı 30 dakika. */
export const BROWSER_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Admin: mutlak üst sınır 8 saat (tercihten bağımsız). */
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
/** Admin: hareketsizlik sınırı 15 dakika. */
export const ADMIN_SESSION_IDLE_MS = 15 * 60 * 1000;
/** Kalıcı olmayan oturumda hareketsizlik penceresi en fazla bu sıklıkta yazılır. */
export const NON_PERSISTENT_TOUCH_INTERVAL_MS = 60 * 1000;

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
  /** "Oturumu açık tut" ile açılmış kalıcı oturum mu? */
  persistent: boolean;
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
  // Yönetici artık portföy OKUMAZ; eylem geçmiş kayıtlar için korunur.
  | "user.portfolio_view"
  | "user.account_view"
  | "user.sessions_view"
  | "user.sessions_revoke"
  | "user.delete_attempt"
  | "user.delete"
  // Sprint 3: ikinci faktör, fiyat kaynağı ve veri hakları eylemleri.
  | "mfa.enroll"
  | "mfa.verify"
  | "mfa.reset"
  | "mfa.recovery_used"
  | "price.provider_update"
  | "price.source_change"
  | "price.refresh"
  | "price.quarantine_view"
  | "price.default_source"
  | "price.experimental_access"
  | "price.mapping_approve"
  | "data.export"
  | "data.deletion_request";

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
