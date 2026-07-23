import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../vitest.config'
import { SUBPROCESS_TIMEOUT_MS, TEST_TIMEOUT_MS } from './timeouts'

/**
 * A test file that says `timeout: 20_000` reads as a promise that a child gets 20
 * seconds. For a long time it was not one: vitest's default budget was 5s, so
 * vitest always killed the test first and the number in the test meant nothing.
 * Nothing complained, because on a fast machine everything finished in well under
 * either figure - it surfaced as one CI failure on a loaded runner.
 *
 * That is a mismatch between a config file and the code it governs, which no test
 * of behaviour can catch. So these check the relationship itself.
 */
describe('subprocess timeouts and the test timeout', () => {
  const testDir = fileURLToPath(new URL('.', import.meta.url))

  it('gives vitest more room than the children it waits on', () => {
    // Strictly greater, not equal: equal is a race, and if vitest wins it we get
    // its generic timeout message instead of the child's own diagnosis.
    expect(config.test?.testTimeout).toBe(TEST_TIMEOUT_MS)
    expect(TEST_TIMEOUT_MS).toBeGreaterThan(SUBPROCESS_TIMEOUT_MS)
  })

  it('leaves no test declaring its own child budget behind the config', () => {
    // Any future `timeout: 45_000` written straight into a test would be fiction
    // again. Point it at the shared constant instead, or raise both together.
    const self = 'timeout-parity.test.ts'
    const offenders: string[] = []
    for (const file of readdirSync(testDir)) {
      if (!file.endsWith('.test.ts') || file === self) continue // the example above is prose
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const [, digits] of source.matchAll(/timeout:\s*([\d_]+)\b/g)) {
        const ms = Number(digits.replace(/_/g, ''))
        if (ms >= TEST_TIMEOUT_MS) offenders.push(`${file}: timeout: ${digits}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
