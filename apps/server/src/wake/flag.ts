/**
 * Wake-budget feature flag gate (phase 12, spec 12 gradual rollout).
 *
 * This is a READ gate over the existing `configuration` table - it does not write
 * rows. key = 'wake_budget_enabled', value = true | false. Resolution precedence:
 *   project row  >  global row  >  default OFF
 * A project row (scope='project', scopeId=projectId) overrides; absent that, the
 * global row (scope='global', scopeId=null) applies; absent both, the default is
 * OFF (safe before dogfooding). Activation is done by inserting a row (phase 10 UI
 * / seed), not by this module.
 *
 * The gate decides ENFORCEMENT only (cap reject, budget suppression, urgent/U,
 * direct cooldown). Coalescing (02), ban (09), and telemetry (wake_event writes)
 * stay OUTSIDE the gate - they run regardless so dogfooding gets a baseline.
 *
 * A small TTL cache keeps the gate off the DB on every hot-path send. Writers
 * (phase 10 toggle UI) should call invalidateWakeFlagCache() after a flag change.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { configurations } from '@relayroom/db'

const KEY = 'wake_budget_enabled'

const cache = new Map<string, { v: boolean; exp: number }>()
const TTL_MS = 5_000

export async function isWakeBudgetEnabled(
  db: Db,
  opts?: { projectId?: string },
): Promise<boolean> {
  const ck = opts?.projectId ?? '__global__'
  const hit = cache.get(ck)
  if (hit && hit.exp > Date.now()) return hit.v

  let enabled = false // module default OFF; deployments turn it ON by seeding a
  // global configuration row (see ensureWakeBudgetDefault on server boot) so the
  // 30/5 throttle caps runaway loops without changing this default (tests rely on it).

  // global row first (fallback), then project override if present.
  const globalRow = await db
    .select({ value: configurations.value })
    .from(configurations)
    .where(
      and(
        eq(configurations.scope, 'global'),
        isNull(configurations.scopeId),
        eq(configurations.key, KEY),
      ),
    )
    .limit(1)
  if (globalRow[0]) enabled = globalRow[0].value === true

  if (opts?.projectId) {
    const projRow = await db
      .select({ value: configurations.value })
      .from(configurations)
      .where(
        and(
          eq(configurations.scope, 'project'),
          eq(configurations.scopeId, opts.projectId),
          eq(configurations.key, KEY),
        ),
      )
      .limit(1)
    if (projRow[0]) enabled = projRow[0].value === true
  }

  cache.set(ck, { v: enabled, exp: Date.now() + TTL_MS })
  return enabled
}

/** Clear the TTL cache. Call after a flag write (phase 10 toggle UI) so the new
 *  value is observed immediately rather than after the TTL window. */
export function invalidateWakeFlagCache(): void {
  cache.clear()
}

/**
 * Seed the GLOBAL wake-budget flag ON when no global row exists yet, so a fresh
 * deployment throttles wakes (30/5) by default and a runaway loop is capped. Called
 * once on server boot. Idempotent; never overrides an existing global row, so a
 * team can still turn it off, and a per-project row still wins.
 */
export async function ensureWakeBudgetDefault(db: Db): Promise<void> {
  const existing = await db
    .select({ value: configurations.value })
    .from(configurations)
    .where(and(eq(configurations.scope, 'global'), isNull(configurations.scopeId), eq(configurations.key, KEY)))
    .limit(1)
  if (existing[0]) return
  await db.insert(configurations).values({ scope: 'global', scopeId: null, key: KEY, value: true })
  invalidateWakeFlagCache()
}
