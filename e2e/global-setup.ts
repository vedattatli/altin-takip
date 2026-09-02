import { rmSync } from "node:fs";
import { join } from "node:path";

import { LocalAuthBackend } from "../src/server/auth/local-backend";

export const E2E_STORE_FILE = "auth-e2e.json";

export const ADMIN = {
  username: "e2eyonetici",
  displayName: "E2E Yöneticisi",
  password: "Yonetici7Kasa",
};

/**
 * Testler için temiz bir yerel veri dosyası hazırlar ve ilk yöneticiyi oluşturur.
 * Bu, üretimde `npm run admin:create` komutunun yaptığı işin test karşılığıdır.
 */
export default async function globalSetup(): Promise<void> {
  process.env.AUTH_LOCAL_STORE_FILE = E2E_STORE_FILE;
  rmSync(join(process.cwd(), ".data", E2E_STORE_FILE), { force: true });

  const backend = new LocalAuthBackend({ fileName: E2E_STORE_FILE });
  const admin = await backend.createUser({
    username: ADMIN.username,
    displayName: ADMIN.displayName,
    temporaryPassword: ADMIN.password,
    role: "admin",
  });
  await backend.setMustChangePassword(admin.id, false);
}
