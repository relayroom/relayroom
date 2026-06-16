import { defineConfig } from 'vitest/config'

// The agent-side CLI has no database; its tests are pure unit tests (URL/arg/
// hook builders + a tmpdir settings merge), so no global DB setup is needed.
export default defineConfig({
  test: { environment: 'node' },
})
