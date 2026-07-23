import { defineConfig } from 'vitest/config'
import { TEST_TIMEOUT_MS } from './test/timeouts'

// The agent-side CLI has no database; its tests are pure unit tests (URL/arg/
// hook builders + a tmpdir settings merge), so no global DB setup is needed.
//
// They are not all instant, though: several spawn a real process (bash running
// the generated rr.sh, node running the pager) and a few wait on retry timers.
// vitest's 5s default sat BELOW the 20s those tests hand their children, so the
// child-level guard could never fire and a loaded CI runner failed a test that
// was only slow. testTimeout stays above that budget deliberately - see
// ./test/timeouts.ts, and the parity test that holds the two numbers together.
export default defineConfig({
  test: { environment: 'node', testTimeout: TEST_TIMEOUT_MS },
})
