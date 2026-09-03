import { getPriceSourceService, requireCurrentAdmin } from "@/server/auth";
import { ok } from "@/server/http";
import { apiRoute } from "@/server/security/route";

/** Yönetici: sağlayıcı listesi, lisans durumu, sağlık ve kapsam. */
export const GET = apiRoute(async () => {
  await requireCurrentAdmin();
  return ok(await getPriceSourceService().adminProviderState());
});
