import type { DeviceMode, UserProfile } from "@/auth/types";
import {
  createAdminActor,
  createUserActor,
  ownScope,
  type AdminActor,
  type DataScope,
  type UserActor,
} from "@/server/auth/actor";

/**
 * Test yardımcıları.
 *
 * Aktör üretimi bilinçli olarak yalnızca sunucu modülünde mümkündür; testler
 * de aynı fabrikaları kullanır. Böylece testler gerçek yetkilendirme sınırını
 * dolanmaz, onu kullanır.
 */
export function userActor(profile: UserProfile, deviceMode: DeviceMode = "personal"): UserActor {
  return createUserActor(profile, deviceMode);
}

export function adminActor(profile: UserProfile, deviceMode: DeviceMode = "personal"): AdminActor {
  return createAdminActor(profile, deviceMode);
}

/** Kullanıcının kendi verisine erişim kapsamı (arka uç çağrıları için). */
export function scopeOf(profile: UserProfile): DataScope {
  return ownScope(createUserActor(profile, "personal"));
}
