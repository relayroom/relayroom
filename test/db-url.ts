/**
 * Single source of truth for the test database URL.
 *
 * Every test file and vitest config imports from here instead of writing the URL
 * out again. The literal 'postgres://hub:hub@localhost:48802/hub_test' used to
 * appear in 18 places, and `global-setup.ts` DROPs that database `WITH (FORCE)`
 * on every run - which force-disconnects any other session attached to it. With
 * one hardcoded name, a second git worktree starting `pnpm test` does not merely
 * race the first one: it destroys the first one's database mid-run.
 *
 * Resolution (first match wins):
 *   1. TEST_DATABASE_URL - full override, used verbatim. The escape hatch.
 *   2. TEST_DB_NAME      - database name only, joined onto TEST_PG_BASE.
 *   3. CI                - 'hub_test'. One checkout per runner, so there is
 *                          nothing to isolate; this keeps CI's behaviour and
 *                          ci.yml's description of it unchanged.
 *   4. otherwise         - 'hub_test_<worktree>'. Each worktree gets its own
 *                          database on the SAME postgres instance; a cluster does
 *                          not care how many databases it holds.
 *
 * Why derive the worktree from the path rather than a per-worktree env file: the
 * path IS the worktree's identity, so it cannot drift out of sync the way a
 * hand-maintained value does, and adding a worktree needs no extra setup step.
 * The cost is that it is implicit, which global-setup pays back by printing
 * TEST_DB_SOURCE on every run.
 *
 * The slug comes from THIS FILE's location, not from cwd. vitest sets cwd to the
 * package under test, so cwd would yield 'server' / 'web' / 'db' inside a single
 * worktree - splitting one worktree across three databases and isolating nothing.
 */
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PG_BASE = 'postgres://hub:hub@localhost:48802'

/** Postgres truncates identifiers at 63 bytes, so two long names could collide
 *  after truncation. Cut it ourselves to keep the name we use and the name the
 *  server stores identical. */
const MAX_IDENTIFIER_LEN = 63

function worktreeSlug(): string {
  // '..' from <root>/test/db-url.ts -> <root>. resolve() drops the trailing slash
  // that fileURLToPath leaves on a directory URL, so basename sees the last segment.
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return slug || 'worktree'
}

function resolveTestDb(): { url: string; name: string; source: string } {
  const explicitUrl = process.env.TEST_DATABASE_URL
  if (explicitUrl) {
    return {
      url: explicitUrl,
      name: databaseNameOf(explicitUrl),
      source: 'TEST_DATABASE_URL override',
    }
  }

  const explicitName = process.env.TEST_DB_NAME
  let name: string
  let source: string
  if (explicitName) {
    name = explicitName
    source = 'TEST_DB_NAME override'
  }
  else if (process.env.CI) {
    name = 'hub_test'
    source = 'CI default'
  }
  else {
    const slug = worktreeSlug()
    name = `hub_test_${slug}`
    source = `worktree directory "${slug}"`
  }
  name = name.slice(0, MAX_IDENTIFIER_LEN)

  const url = new URL(process.env.TEST_PG_BASE ?? DEFAULT_PG_BASE)
  url.pathname = `/${name}`
  return { url: url.toString(), name, source }
}

function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

const resolved = resolveTestDb()

/** Connection string for the throwaway test database. */
export const TEST_DATABASE_URL = resolved.url

/** Bare database name - what global-setup creates, drops, and locks on. */
export const TEST_DB_NAME = resolved.name

/** How TEST_DB_NAME was chosen. Printed once per run so "why is it on that
 *  database?" is answerable from the test output alone. */
export const TEST_DB_SOURCE = resolved.source

/** Same server, but pointed at the always-present `postgres` database: you cannot
 *  drop a database while connected to it. */
export const ADMIN_DATABASE_URL = (() => {
  const admin = new URL(TEST_DATABASE_URL)
  admin.pathname = '/postgres'
  return admin.toString()
})()

/** Human-readable server address for error messages (never includes credentials). */
export const TEST_PG_HOST = new URL(TEST_DATABASE_URL).host

/**
 * Advisory-lock key for a database name.
 *
 * Per-worktree names are a convention; `DROP DATABASE ... WITH (FORCE)` is a
 * weapon, and a convention cannot disarm one. Two runs that resolve to the SAME
 * name (a hand-set TEST_DB_NAME, two worktrees whose directories share a
 * basename) would still destroy each other. global-setup holds this lock for the
 * whole run, so that case degrades to "wait your turn" instead of "lose your data".
 * Different names hash to different keys and never contend.
 *
 * FNV-1a, computed here rather than with postgres's `hashtext()`: that function is
 * undocumented and carries no cross-version stability guarantee, and a lock key
 * that changes underneath us is a lock that silently stops locking.
 */
export function advisoryLockKey(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0 // signed 32-bit; pg_advisory_lock takes a bigint
}

/** Quote an identifier for interpolation into DDL. Doubling `"` is the only
 *  escape SQL identifiers have; the name reaches us from env, so it is not ours
 *  to trust. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
