/**
 * Oturumun açıldığı cihaz türü.
 *
 * "personal": kullanıcının kendi cihazı. Oturum çerezi kalıcıdır.
 * "shared":   şirket / ortak kullanılan cihaz. Oturum çerezi tarayıcı kapanınca
 *             silinir, 15 dakika hareketsizlikte otomatik çıkış yapılır, servis
 *             çalışanı kaydedilmez ve PWA kurulum çağrısı gösterilmez.
 */
export type DeviceMode = "personal" | "shared";

export const DEVICE_MODE_LABELS: Record<DeviceMode, string> = {
  personal: "Kişisel cihaz",
  shared: "Şirket / ortak cihaz",
};

/** Paylaşılan cihazda hareketsizlik sonrası otomatik çıkış süresi. */
export const SHARED_DEVICE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Paylaşılan cihazda oturumun en uzun ömrü (hareket olsa bile). */
export const SHARED_DEVICE_ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** Kişisel cihazda oturumun en uzun ömrü. Mutlak süre burada da zorunludur. */
export const PERSONAL_DEVICE_ABSOLUTE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * last_seen_at / idle_expires_at yazımı bu aralıktan sık yapılmaz.
 * Her istekte veritabanına yazmak gereksiz yüktür.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionPolicy {
  /** Hareketsizlik süresi. null ise hareketsizlik zaman aşımı yoktur. */
  idleTimeoutMs: number | null;
  /** Oturumun mutlak ömrü. Her cihaz türünde zorunludur. */
  absoluteLifetimeMs: number;
  /** Çerez kalıcı mı? Ortak cihazda tarayıcı kapanınca silinir. */
  persistentCookie: boolean;
}

/**
 * Oturum süresi politikası — GÜVENLİK SINIRI SUNUCUDADIR.
 * İstemcideki sayaç yalnızca kullanıcı deneyimi içindir.
 */
export function sessionPolicyFor(deviceMode: DeviceMode): SessionPolicy {
  if (deviceMode === "shared") {
    return {
      idleTimeoutMs: SHARED_DEVICE_IDLE_TIMEOUT_MS,
      absoluteLifetimeMs: SHARED_DEVICE_ABSOLUTE_LIFETIME_MS,
      persistentCookie: false,
    };
  }
  return {
    idleTimeoutMs: null,
    absoluteLifetimeMs: PERSONAL_DEVICE_ABSOLUTE_LIFETIME_MS,
    persistentCookie: true,
  };
}

/**
 * Test kaçış kapısı belirteci.
 *
 * Yalnızca otomatik testler için vardır ve kazara açılamasın diye bilinçli olarak
 * tahmin edilmesi zor bir değerdir. Üretim dağıtımlarında ASLA ayarlanmaz.
 */
export const TEST_OVERRIDE_TOKEN = "yalnizca-test-icin";

/**
 * Hareketsizlik süresini çözer.
 *
 * Süre üretimde HER ZAMAN 15 dakikadır. Yalnızca test kaçış kapısı açıkça
 * etkinleştirildiğinde kısaltılabilir; aksi hâlde geçersiz veya eksik değer
 * yok sayılır.
 */
export function resolveIdleTimeoutMs(env: {
  allowTestOverrides?: string;
  overrideMs?: string;
}): number {
  if (env.allowTestOverrides !== TEST_OVERRIDE_TOKEN) return SHARED_DEVICE_IDLE_TIMEOUT_MS;
  const override = Number(env.overrideMs ?? "");
  if (!Number.isFinite(override) || override <= 0) return SHARED_DEVICE_IDLE_TIMEOUT_MS;
  return override;
}

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
