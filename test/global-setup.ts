import postgres from 'postgres'
import {
  ADMIN_DATABASE_URL,
  TEST_DATABASE_URL,
  TEST_DB_NAME,
  TEST_DB_SOURCE,
  TEST_PG_HOST,
  advisoryLockKey,
  quoteIdentifier,
} from './db-url'

// This module used to export TEST_DATABASE_URL as well. It no longer does: two
// import paths for one value is how the literal ended up copied into 18 files in
// the first place. Test code imports it from ./db-url (or, in apps/server, from
// ./helpers, which re-exports that one).
export default async function setup() {
  // max: 1 plus a reserved connection below - the advisory lock is SESSION scoped,
  // so it must live on one specific backend connection that we keep open for the
  // entire run. A pooled handle could hand us a different connection later and the
  // lock would be silently gone.
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} })

  let conn: Awaited<ReturnType<typeof admin.reserve>>
  try {
    conn = await admin.reserve()
  }
  catch (err) {
    await admin.end({ timeout: 0 }).catch(() => {})
    // The raw ECONNREFUSED stack says nothing about what to do about it. Postgres
    // is expected to be running once, from the main worktree - see rr-docs.
    throw new Error(
      `[test-db] cannot reach postgres at ${TEST_PG_HOST}.\n`
      + `  Start it ONCE, from the main worktree:  pnpm db:up\n`
      + `  (that worktree needs a .env; docker compose parses the whole file and\n`
      + `   fails on the web service's variables even when only postgres is asked for)\n`
      + `  Do not start a second instance from another worktree - they all bind the\n`
      + `  same port and each writes its own ./db_data.\n`
      + `  Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    // Held until teardown. Uncontended when each worktree has its own database
    // name; when two runs DO resolve to the same name this is what makes the
    // second one wait instead of force-dropping the first one's database.
    await conn.unsafe(`SELECT pg_advisory_lock(${advisoryLockKey(TEST_DB_NAME)})`)

    const ident = quoteIdentifier(TEST_DB_NAME)
    // WITH (FORCE) stays: it clears connections leaked by a previous run of THIS
    // suite. Holding the lock first is what keeps it from reaching a live one.
    await conn.unsafe(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`)
    await conn.unsafe(`CREATE DATABASE ${ident}`)

    // The name is derived, not configured, so say where it came from. Otherwise
    // "which database did that run use, and why" is only answerable by reading
    // db-url.ts.
    console.log(`[test-db] ${TEST_DB_NAME} on ${TEST_PG_HOST} (${TEST_DB_SOURCE})`)

    const { createDb } = await import('../packages/db/src/client')
    const { runMigrations } = await import('../packages/db/src/migrate')
    const db = createDb(TEST_DATABASE_URL)
    await runMigrations(db)
    await db.$client.end()
  }
  catch (err) {
    conn.release()
    await admin.end({ timeout: 0 }).catch(() => {})
    throw err
  }

  // vitest calls this once every test file has finished. Releasing the connection
  // drops the advisory lock; if the process dies instead, postgres releases it when
  // the backend goes away, so there is no stale-lock state to clean up by hand.
  return async () => {
    conn.release()
    await admin.end({ timeout: 5 }).catch(() => {})
  }
}
