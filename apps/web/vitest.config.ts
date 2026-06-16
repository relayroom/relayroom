import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" -> "./*" path alias so module imports resolve.
    alias: [{ find: /^@\//, replacement: root }],
  },
  test: {
    environment: "node",
    globalSetup: "../../test/global-setup.ts",
    fileParallelism: false,
    // Point the shared db singleton (lib/db.ts reads process.env.DATABASE_URL)
    // at the throwaway hub_test database that global-setup creates + migrates.
    env: { DATABASE_URL: "postgres://hub:hub@localhost:48802/hub_test" },
  },
})
