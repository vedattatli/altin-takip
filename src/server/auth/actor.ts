import "server-only";

import type { DeviceMode, UserProfile } from "@/auth/types";

/**
 * Yetkilendirme sınırı tipleri.
 *
 * NEDEN VAR
 * BFF (sunucu) katmanı Supabase'e service_role ile bağlanır ve service_role RLS'yi
 * ATLAR. Bu yüzden hangi satırın kime ait olduğunu belirleyen tek gerçek sınır
 * sunucudaki actor authorization'dır. Ham `string` bir userId'nin veri metotlarına
 * geçirilebilmesi, bir route'un yanlışlıkla başka kullanıcının verisine erişmesi
 * demektir.
 *
 * ÇÖZÜM
 * Veri metotları artık `string` değil, markalanmış (branded) `DataScope` alır.
 * `DataScope` yalnızca bu modüldeki iki fabrika ile üretilebilir:
 *
 *   ownScope(actor)              -> doğrulanmış kullanıcının KENDİ verisi
 *   adminScope(admin, targetId)  -> yöneticinin BAŞKA kullanıcıyı hedeflemesi
 *
 * Normal kullanıcı route'ları `AdminActor` üretemediği için `adminScope`
 * çağıramaz; dolayısıyla derleme zamanında başka kullanıcının verisine
 * erişemezler.
 */

declare const ACTOR_BRAND: unique symbol;

/** Doğrulanmış, kendi verisine erişen kullanıcı. */
export interface UserActor {
  readonly [ACTOR_BRAND]: "user";
  readonly profile: UserProfile;
  readonly deviceMode: DeviceMode;
}

/** Doğrulanmış yönetici. Yalnızca requireCurrentAdmin üretebilir. */
export interface AdminActor {
  readonly [ACTOR_BRAND]: "admin";
  readonly profile: UserProfile;
  readonly deviceMode: DeviceMode;
}

/**
 * Veri erişim kapsamı. Yalnızca aşağıdaki fabrikalarla üretilir; bir route
 * gövdeden/parametreden gelen bir dizeyi bu türe dönüştüremez.
 */
export interface DataScope {
  readonly [ACTOR_BRAND]: "scope";
  readonly userId: string;
  /** Denetim ve hata ayıklama için: kapsamın nasıl elde edildiği. */
  readonly origin: "self" | "admin";
}

/** İç kullanım: doğrulanmış oturumdan aktör üretir. */
export function createUserActor(profile: UserProfile, deviceMode: DeviceMode): UserActor {
  return { profile, deviceMode } as UserActor;
}

/** İç kullanım: rolü doğrulanmış yöneticiden admin aktörü üretir. */
export function createAdminActor(profile: UserProfile, deviceMode: DeviceMode): AdminActor {
  if (profile.role !== "admin") {
    throw new Error("createAdminActor yalnızca admin rolündeki profille çağrılabilir.");
  }
  return { profile, deviceMode } as AdminActor;
}

/** Kullanıcının kendi verisine erişim kapsamı. */
export function ownScope(actor: UserActor): DataScope {
  return { userId: actor.profile.id, origin: "self" } as DataScope;
}

/**
 * Yöneticinin başka bir kullanıcıyı hedeflemesi.
 * Yalnızca admin servislerinde kullanılır ve her çağrısı denetim kaydı üretir.
 */
export function adminScope(admin: AdminActor, targetUserId: string): DataScope {
  if (admin.profile.role !== "admin") {
    throw new Error("adminScope yalnızca admin aktörüyle çağrılabilir.");
  }
  return { userId: targetUserId, origin: "admin" } as DataScope;
}

/** Testler ve arka uç uygulamaları için kapsamdan kullanıcı kimliğini okur. */
export function scopeUserId(scope: DataScope): string {
  return scope.userId;
}
