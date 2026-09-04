import { getAdminService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

const SCREEN_CODE = "sarraf-tv-kayseri-screen";

/**
 * Yönetici: Kayseri ekran worker'ının kira ve heartbeat durumu.
 *
 * Salt okunur. Buradan yazılan bir şey yoktur.
 *
 * ESKİDEN BURADA NE VARDI: kullanıcı bazlı "deneysel kaynak izin listesi"
 * (GET access + PUT). O katman ürün kararıyla kaldırıldı — ikinci bir kapı
 * yalnızca arıza üretiyordu: izin verilmemiş kaynaktaki ürünler sessizce
 * fiyatsız kalıyor, kullanıcı uygulamayı bozuk sanıyordu.
 */
export const GET = apiRoute(async () => {
  const actor = await requireCurrentAdmin();
  const worker = await getAdminService().screenWorkerState(actor, SCREEN_CODE);
  return ok({ worker });
});
