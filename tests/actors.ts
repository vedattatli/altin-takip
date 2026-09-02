import type { UserProfile } from "@/auth/types";
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
export function userActor(profile: UserProfile, sessionId = "test-session"): UserActor {
  return createUserActor(profile, sessionId);
}

export function adminActor(profile: UserProfile, sessionId = "test-admin-session"): AdminActor {
  return createAdminActor(profile, sessionId);
}

/** Kullanıcının kendi verisine erişim kapsamı (arka uç çağrıları için). */
export function scopeOf(profile: UserProfile): DataScope {
  return ownScope(createUserActor(profile, "test-session"));
}
