import { getAuthService, requireCurrentAdmin } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

/**
 * Yönetici: geçici parola atama.
 * Yönetici mevcut parolayı GÖREMEZ; yalnızca yeni geçici parola belirleyebilir.
 * Sıfırlama sonrası kullanıcının tüm oturumları düşer ve parola değiştirmesi istenir.
 */
export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireCurrentAdmin();
    const { id } = await context.params;
    const body = await readJson<{ temporaryPassword?: string }>(request);
    const updated = await getAuthService().resetUserPassword(
      actor,
      id,
      body.temporaryPassword ?? "",
    );
    return ok(updated);
  } catch (error) {
    return failure(error);
  }
}
