import { toSessionUser } from "@/auth/types";
import { getCurrentUser } from "@/server/auth";
import { failure, ok } from "@/server/http";

export async function GET() {
  try {
    const profile = await getCurrentUser();
    return ok({ user: profile ? toSessionUser(profile) : null });
  } catch (error) {
    return failure(error);
  }
}
