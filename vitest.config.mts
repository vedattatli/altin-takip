import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Next.js yol takma adı (@/*) testlerde de geçerli olsun.
      "@": `${root}src`,
      // "server-only" paketi Node ortamında hata fırlatır; testlerde boş modüle eşlenir.
      "server-only": `${root}tests/stubs/server-only.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
  },
});
