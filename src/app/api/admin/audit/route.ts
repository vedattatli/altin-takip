import { getAuthService, requireCurrentAdmin } from "@/server/auth";
import { failure, ok } from "@/server/http";

export async function GET(request: Request) {
  try {
    const actor = await requireCurrentAdmin();
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
    return ok(await getAuthService().listAudit(actor, Math.min(Math.max(limit, 1), 200)));
  } catch (error) {
    return failure(error);
  }
}
