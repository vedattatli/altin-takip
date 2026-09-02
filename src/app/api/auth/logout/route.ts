import { cookies } from "next/headers";

import { getAuthService, readSessionToken, SESSION_COOKIE } from "@/server/auth";
import { failure, ok } from "@/server/http";

export async function POST() {
  try {
    const token = await readSessionToken();
    await getAuthService().logout(token);
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return ok({ signedOut: true });
  } catch (error) {
    return failure(error);
  }
}
