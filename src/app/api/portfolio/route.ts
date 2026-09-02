import { getAuthBackend, requireCurrentUser } from "@/server/auth";
import { failure, ok, readJson } from "@/server/http";

export async function GET() {
  try {
    const actor = await requireCurrentUser();
    return ok(await getAuthBackend().getPortfolio(actor.id));
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireCurrentUser();
    const body = await readJson<{ name?: string; displayName?: string }>(request);
    const patch = {
      ...(typeof body.name === "string" ? { name: body.name.trim().slice(0, 80) } : {}),
      ...(typeof body.displayName === "string"
        ? { displayName: body.displayName.trim().slice(0, 80) }
        : {}),
    };
    return ok(await getAuthBackend().updatePortfolio(actor.id, patch));
  } catch (error) {
    return failure(error);
  }
}
