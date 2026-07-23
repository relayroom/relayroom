/**
 * Feature-flag gate (phase 12): wake_budget_enabled resolution + TTL cache.
 *
 * Precedence: project row > global row > default OFF. The gate is a READ over the
 * `configuration` table; activation is an inserted row. Verifies the gate value
 * and that invalidateWakeFlagCache() picks up a fresh write.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import { configurations } from '@relayroom/db'
import { invalidateWakeFlagCache, isWakeBudgetEnabled } from '../src/wake/flag'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)

const KEY = 'wake_budget_enabled'

async function clearFlags(): Promise<void> {
  await db.delete(configurations).where(eq(configurations.key, KEY))
  invalidateWakeFlagCache()
}

async function setGlobal(value: boolean): Promise<void> {
  await db.insert(configurations).values({ scope: 'global', scopeId: null, key: KEY, value })
  invalidateWakeFlagCache()
}

async function setProject(projectId: string, value: boolean): Promise<void> {
  await db.insert(configurations).values({ scope: 'project', scopeId: projectId, key: KEY, value })
  invalidateWakeFlagCache()
}

beforeEach(async () => {
  await clearFlags()
})

afterAll(async () => {
  await clearFlags()
  await db.$client.end()
})

describe('isWakeBudgetEnabled - feature flag gate', () => {
  it('defaults OFF when no rows exist', async () => {
    expect(await isWakeBudgetEnabled(db)).toBe(false)
    expect(await isWakeBudgetEnabled(db, { projectId: '00000000-0000-0000-0000-000000000001' })).toBe(false)
  })

  it('global=true turns it ON for global and for a project with no override', async () => {
    await setGlobal(true)
    expect(await isWakeBudgetEnabled(db)).toBe(true)
    expect(await isWakeBudgetEnabled(db, { projectId: '00000000-0000-0000-0000-000000000002' })).toBe(true)
  })

  it('project override > global (project=false beats global=true)', async () => {
    const pid = '00000000-0000-0000-0000-000000000003'
    await setGlobal(true)
    await setProject(pid, false)
    expect(await isWakeBudgetEnabled(db, { projectId: pid })).toBe(false)
    // global view unchanged
    expect(await isWakeBudgetEnabled(db)).toBe(true)
  })

  it('project=true beats global absent/false', async () => {
    const pid = '00000000-0000-0000-0000-000000000004'
    await setProject(pid, true)
    expect(await isWakeBudgetEnabled(db, { projectId: pid })).toBe(true)
    // a different project with no row falls back to default OFF
    expect(await isWakeBudgetEnabled(db, { projectId: '00000000-0000-0000-0000-000000000005' })).toBe(false)
  })

  it('invalidateWakeFlagCache picks up a fresh write', async () => {
    expect(await isWakeBudgetEnabled(db)).toBe(false) // caches OFF
    await db.insert(configurations).values({ scope: 'global', scopeId: null, key: KEY, value: true })
    // without invalidation the TTL cache still returns the old value
    expect(await isWakeBudgetEnabled(db)).toBe(false)
    invalidateWakeFlagCache()
    expect(await isWakeBudgetEnabled(db)).toBe(true)
    // sanity: the row we inserted is the only global one
    const rows = await db
      .select({ id: configurations.id })
      .from(configurations)
      .where(and(eq(configurations.scope, 'global'), isNull(configurations.scopeId), eq(configurations.key, KEY)))
    expect(rows).toHaveLength(1)
  })
})
