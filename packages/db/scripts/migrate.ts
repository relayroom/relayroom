/**
 * `pnpm --filter @relayroom/db migrate`.
 *
 * A file rather than a `tsx -e "..."` one-liner in package.json: pnpm hands the
 * script to a shell, and the shell expanded `db.$client.end()` into `db..end()`
 * (`$client` being an unset variable), so the command failed to parse and the
 * script had never once run. Code that a shell rewrites before any interpreter
 * sees it cannot be reviewed by reading it.
 */
import { createDb, runMigrations } from '../src/index'

const db = createDb()
try {
  await runMigrations(db)
  console.log('migrations applied')
}
finally {
  await db.$client.end()
}
