import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import { TEST_DATABASE_URL } from "../../test/db-url"

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
    // Point the shared db singleton (lib/db.ts reads process.env.DATABASE_URL) at
    // the throwaway database global-setup creates + migrates. Taken from the same
    // module global-setup uses - written out again here, it silently drifted and
    // pinned this suite to a database nobody else was using.
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
})
