import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const run = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * The migrate script had been broken from the day it was written and nothing
 * noticed, because nothing ever ran it: pnpm hands a script to a shell, and the
 * shell ate `$client` out of the inlined `db.$client.end()` before tsx parsed it.
 *
 * So this runs the script the way pnpm does - through a shell, from package.json,
 * not by importing runMigrations - because the shell is exactly the layer that
 * broke it. A test that imported the module would have stayed green throughout.
 */
describe('the migrate script', () => {
  const script = () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.scripts.migrate as string
  }

  it('survives the shell that runs it', async () => {
    // Already-applied migrations are a no-op, so this is also the idempotence
    // check the server relies on when it migrates on every boot.
    const { stdout } = await run('sh', ['-c', script()], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    })
    expect(stdout).toContain('migrations applied')
  }, 60_000)

  it('keeps the command out of reach of shell expansion', () => {
    // The specific failure was an unquoted `$` in an inlined program. Any `$` or
    // backtick here means the shell is rewriting code again.
    expect(script()).not.toMatch(/[$`]/)
  })
})
