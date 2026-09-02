import { cookies } from "next/headers";

import {
  clientKey,
  getAuthService,
  isSecureRequest,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";

/**
 * Kullanıcı adı + parola ile giriş.
 *
 * Herkese açık KAYIT ucu YOKTUR. Kullanıcılar yalnızca yönetici tarafından
 * oluşturulur. Bu uç yalnızca mevcut bir hesabın kimliğini doğrular.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{
      username?: string;
      password?: string;
      deviceMode?: string;
    }>(request);

    // Yalnızca "personal" açıkça seçilirse kalıcı oturum verilir; aksi hâlde
    // en kısıtlayıcı mod (ortak cihaz) uygulanır.
    const deviceMode = body.deviceMode === "personal" ? "personal" : "shared";

    const service = getAuthService();
    const result = await service.login(
      body.username ?? "",
      body.password ?? "",
      await clientKey(),
      deviceMode,
    );

    const store = await cookies();
    store.set(
      SESSION_COOKIE,
      result.token,
      sessionCookieOptions(result.expiresAt, result.deviceMode, await isSecureRequest()),
    );

    return ok({ user: result.user, deviceMode: result.deviceMode });
  } catch (error) {
    return failure(error);
  }
}
