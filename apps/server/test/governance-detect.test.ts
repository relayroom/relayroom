import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  authSchema,
  governanceAlerts,
  projectAccess,
  projects,
  wakeEvents,
} from '@relayroom/db'
import {
  collectSignals,
  GOVERNANCE_THRESHOLDS,
  resolveStaleAlerts,
  runGovernanceDetection,
} from '../src/governance/detect'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)

const SENDER = 'user_sender_08'
const OWNER_B = 'user_owner_b_08'
let projectId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

/** Insert a wake_event row. createdAtOffsetMs < 0 places it in the past. */
async function seedWake(opts: {
  senderUserId?: string | null
  ownerUserId?: string | null
  senderPart?: string
  phantom?: boolean
  suppressed?: boolean
  reason?: string | null
  createdAtOffsetMs?: number
}): Promise<void> {
  const createdAt = new Date(Date.now() + (opts.createdAtOffsetMs ?? -1000))
  await db.insert(wakeEvents).values({
    projectId,
    senderUserId: opts.senderUserId === undefined ? SENDER : opts.senderUserId,
    ownerUserId: opts.ownerUserId === undefined ? SENDER : opts.ownerUserId,
    senderPart: opts.senderPart ?? 'alpha',
    phantom: opts.phantom ?? false,
    suppressed: opts.suppressed ?? false,
    reason: opts.reason ?? null,
    createdAt,
  })
}

async function openAlerts(kind?: string) {
  const rows = await db
    .select()
    .from(governanceAlerts)
    .where(isNull(governanceAlerts.resolvedAt))
  return kind ? rows.filter(r => r.kind === kind) : rows
}

beforeEach(async () => {
  await db.delete(governanceAlerts)
  await db.delete(wakeEvents)
  await db.delete(projectAccess)
  await db.delete(projects)
  await db
    .delete(authSchema.better_auth_user)
    .where(eq(authSchema.better_auth_user.id, SENDER))
  await db
    .delete(authSchema.better_auth_user)
    .where(eq(authSchema.better_auth_user.id, OWNER_B))

  await seedUser(SENDER)
  await seedUser(OWNER_B)
  const [p] = await db
    .insert(projects)
    .values({
      organizationId: 'org_08',
      slug: `s08_${Date.now()}`,
      name: 'P08',
      connectCode: `cc_08_${Date.now()}`,
    })
    .returning()
  projectId = p.id
})

afterAll(async () => {
  await db.$client.end()
})

describe('governance detection', () => {
  it('phantom_turns: trips at threshold, not below', async () => {
    // 4 phantom events -> below threshold (5) -> no alert.
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns - 1; i++) {
      await seedWake({ phantom: true })
    }
    expect(await runGovernanceDetection(db)).toBe(0)
    expect(await openAlerts('phantom_turns')).toHaveLength(0)

    // one more -> hits threshold -> one alert.
    await seedWake({ phantom: true })
    expect(await runGovernanceDetection(db)).toBe(1)
    const alerts = await openAlerts('phantom_turns')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.subjectUserId).toBe(SENDER)
    expect(alerts[0]!.detail).toMatchObject({ count: GOVERNANCE_THRESHOLDS.phantomTurns })
  })

  it('loop_breaker: aggregates reason=loop_breaker suppressed rows', async () => {
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.loopBreakerTrips; i++) {
      await seedWake({ reason: 'loop_breaker', suppressed: true })
    }
    expect(await runGovernanceDetection(db)).toBe(1)
    expect(await openAlerts('loop_breaker')).toHaveLength(1)
  })

  it('stable principal: same sender across different parts is summed, not split', async () => {
    // 3 phantom on part alpha + 2 on part beta = 5 on the same senderUserId -> trips,
    // proving part rotation cannot hide the pattern.
    for (let i = 0; i < 3; i++) await seedWake({ phantom: true, senderPart: 'alpha' })
    for (let i = 0; i < 2; i++) await seedWake({ phantom: true, senderPart: 'beta' })
    const signals = await collectSignals(db)
    const phantom = signals.filter(s => s.kind === 'phantom_turns')
    expect(phantom).toHaveLength(1)
    expect(phantom[0]!.detail).toMatchObject({ count: 5 })
  })

  it('dedup: repeated trips keep a single open alert across ticks', async () => {
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns; i++) await seedWake({ phantom: true })
    expect(await runGovernanceDetection(db)).toBe(1)
    // seed more of the same pattern and tick twice more
    for (let i = 0; i < 3; i++) await seedWake({ phantom: true })
    expect(await runGovernanceDetection(db)).toBe(0)
    expect(await runGovernanceDetection(db)).toBe(0)
    expect(await openAlerts('phantom_turns')).toHaveLength(1)
  })

  it('auto-resolve: closes the alert when the pattern leaves the window, re-trips fresh', async () => {
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns; i++) await seedWake({ phantom: true })
    await runGovernanceDetection(db)
    expect(await openAlerts('phantom_turns')).toHaveLength(1)

    // push all events past the window (older than 60 min) -> pattern gone
    await db.delete(wakeEvents)
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns; i++) {
      await seedWake({ phantom: true, createdAtOffsetMs: -(GOVERNANCE_THRESHOLDS.windowMs + 60_000) })
    }
    const resolved = await resolveStaleAlerts(db)
    expect(resolved).toBe(1)
    expect(await openAlerts('phantom_turns')).toHaveLength(0)

    // a new burst inside the window opens a NEW alert (the old one is closed)
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns; i++) await seedWake({ phantom: true })
    expect(await runGovernanceDetection(db)).toBe(1)
    expect(await openAlerts('phantom_turns')).toHaveLength(1)

    const all = await db
      .select()
      .from(governanceAlerts)
      .where(eq(governanceAlerts.kind, 'phantom_turns'))
    expect(all).toHaveLength(2) // one resolved + one open
  })

  it('budget_drain: trips when sender drains others budget above share + min sample', async () => {
    // SENDER consumes OWNER_B's wake budget: ownerUserId=OWNER_B, senderUserId=SENDER.
    const n = GOVERNANCE_THRESHOLDS.budgetDrainMinWakes + 1
    for (let i = 0; i < n; i++) {
      await seedWake({ senderUserId: SENDER, ownerUserId: OWNER_B })
    }
    expect(await runGovernanceDetection(db)).toBeGreaterThanOrEqual(1)
    expect(await openAlerts('budget_drain')).toHaveLength(1)
  })

  it('budget_drain: does NOT trip below the minimum sample', async () => {
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.budgetDrainMinWakes - 1; i++) {
      await seedWake({ senderUserId: SENDER, ownerUserId: OWNER_B })
    }
    await runGovernanceDetection(db)
    expect(await openAlerts('budget_drain')).toHaveLength(0)
  })

  it('window boundary: events older than 60 min are excluded', async () => {
    for (let i = 0; i < GOVERNANCE_THRESHOLDS.phantomTurns; i++) {
      await seedWake({ phantom: true, createdAtOffsetMs: -(GOVERNANCE_THRESHOLDS.windowMs + 60_000) })
    }
    const signals = await collectSignals(db)
    expect(signals).toHaveLength(0)
  })
})
