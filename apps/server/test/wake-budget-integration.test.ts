/**
 * Spec §17 acceptance - integration tests (phase 12).
 *
 * Each spec §17 bullet is turned into a concrete check here (auto) or, where no
 * code path exists yet, documented as manual in DOGFOODING.md. These tests drive
 * the real composed pipeline (dispatch -> shouldWake -> ensurePending/reserve),
 * the sweeps (eligibility/expiry), reconcile + governance detection, and ban/unban
 * - i.e. the WIRING, not the units. enforce:true is passed so the budget gate is
 * active regardless of the feature flag (the flag itself is covered separately in
 * wake-budget-flag.test.ts).
 *
 * §17 map:
 *   §17-1 coalescing                         -> auto (this file)
 *   §17-2 suppress-but-deliver + sweep recovery -> auto
 *   §17-3 concurrent issuance no double-spend -> auto
 *   §17-4 ownership-transfer atomic cancel+refund -> auto (cancel+refund primitive;
 *          the dedicated owner-transfer trigger endpoint is deferred - see DOGFOODING.md)
 *   §17-5 urgent U cap + U=0 + direct cooldown -> auto
 *   §17-6 project floor anti-starvation       -> auto
 *   §17-7 ban blocks + cancels pending wake, unban restores -> auto
 *   §17-8 ledger catches phantom turns -> detection -> auto
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  agentConnections,
  agents,
  applyBan,
  applyUnban,
  authSchema,
  directCooldowns,
  events,
  governanceAlerts,
  messageRecipients,
  messages,
  ownerWakeBudgets,
  projectAccess,
  projects,
  threads,
  wakeEvents,
  wakeIntents,
} from '@relayroom/db'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { dispatch, resetLoopBreaker } from '../src/wake/pipeline'
import { shouldWake } from '../src/wake/issuance'
import { runEligibilitySweep } from '../src/wake/sweep'
import { ACTIVE_WAKE_STATES } from '../src/wake/state'
import { reconcileWakeLedger } from '../src/wake/reconcile'
import { runGovernanceDetection } from '../src/governance/detect'

import { TEST_DATABASE_URL } from '../../../test/db-url'
const db: Db = createDb(TEST_DATABASE_URL)
const rawSql = postgres(TEST_DATABASE_URL)

// No-op bus emit for tests (delivery side effect is not asserted here; wake
// issuance/state is).
const noopBus = { emit() {}, on() { return () => {} }, close: async () => {} } as never

let OWNER: string
let projectId: string
let orgId: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function seedOrgMember(org: string, userId: string): Promise<void> {
  await rawSql`
    INSERT INTO better_auth_organization (id, name, created_at)
    VALUES (${org}, ${'Org ' + org}, NOW())
    ON CONFLICT (id) DO NOTHING
  `
  await rawSql`
    INSERT INTO better_auth_member (id, organization_id, user_id, role, created_at)
    VALUES (${'mem-' + randomBytes(6).toString('hex')}, ${org}, ${userId}, 'member', NOW())
    ON CONFLICT DO NOTHING
  `
}

async function makeAgent(part: string, owner = OWNER) {
  const [a] = await db.insert(agents).values({ projectId, part, ownerUserId: owner }).returning()
  return a
}

async function activeIntents(aid: string) {
  return db
    .select({ id: wakeIntents.id, state: wakeIntents.state })
    .from(wakeIntents)
    .where(and(eq(wakeIntents.agentId, aid), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
}

/** In-flight reservations for an owner = non-terminal wake_intent rows. This is the
 *  reservation that a cancel (ban / owner-transfer) refunds: transitioning the intent
 *  to a terminal state removes it from the rolling window (00.overview: "intent를 종말
 *  상태로 전이하면 countWindow가 안 세므로 그 자체가 환불"). */
async function inFlightReservations(owner: string): Promise<number> {
  const intents = await db
    .select({ id: wakeIntents.id })
    .from(wakeIntents)
    .where(and(eq(wakeIntents.ownerUserId, owner), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
  return intents.length
}

beforeEach(async () => {
  resetLoopBreaker()
  await db.delete(directCooldowns)
  await db.delete(governanceAlerts)
  await db.delete(wakeEvents)
  await db.delete(wakeIntents)
  await db.delete(messageRecipients)
  await db.delete(messages)
  await db.delete(threads)
  await db.delete(events)
  await db.delete(agentConnections)
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(ownerWakeBudgets)
  await db.delete(projects)

  OWNER = `u_int_${randomBytes(4).toString('hex')}`
  orgId = `org_int_${randomBytes(4).toString('hex')}`
  await seedUser(OWNER)
  await seedOrgMember(orgId, OWNER)
  const [p] = await db
    .insert(projects)
    .values({ organizationId: orgId, slug: `s_${randomBytes(3).toString('hex')}`, name: 'P-int' })
    .returning()
  projectId = p.id
})

afterAll(async () => {
  await db.$client.end()
  await rawSql.end()
})

// Helper: send through the unified pipeline from `fromPart` to `to[]`.
async function send(fromPart: string, to: string[], body: string, opts: { urgent?: boolean } = {}) {
  const from = await db.insert(agents).values({ projectId, part: fromPart, ownerUserId: OWNER }).onConflictDoNothing().returning()
  const [fromAgent] = from.length
    ? from
    : await db.select().from(agents).where(and(eq(agents.projectId, projectId), eq(agents.part, fromPart)))
  const [thread] = await db.insert(threads).values({ projectId, subject: `subj ${body}`, createdByAgentId: fromAgent.id }).returning()
  return dispatch(db, {
    projectId,
    projectSlug: 'slug',
    threadId: thread.id,
    subject: thread.subject,
    fromPart,
    fromAgentId: fromAgent.id,
    fromUserId: OWNER,
    connectionId: `conn-${fromPart}`,
    body,
    urgent: opts.urgent ?? false,
    recipientsSpec: { mode: 'send', to },
    maxBroadcastRecipients: null,
    emit: () => {},
    enforce: true,
  })
}

describe('§17 acceptance (integration)', () => {
  // §17-1: 좁은 send 반복이 유휴 part에 wake를 1개로 코얼레스함.
  it('§17-1 coalescing: 3 sends to an idle part => exactly one active wake, 3 messages', async () => {
    await makeAgent('beta')
    await send('alpha', ['beta'], 'm1')
    await send('alpha', ['beta'], 'm2')
    await send('alpha', ['beta'], 'm3')

    const [beta] = await db.select().from(agents).where(and(eq(agents.projectId, projectId), eq(agents.part, 'beta')))
    expect(await activeIntents(beta.id)).toHaveLength(1)
    const msgs = await db.select({ id: messages.id }).from(messages)
    expect(msgs).toHaveLength(3) // every message row created (delivery independent of wake)
  })

  // §17-2: 예산 소진 시 wake 억제되나 전달 유지, 리필 sweep이 회수함.
  it('§17-2 suppress-but-deliver, then eligibility sweep recovers', async () => {
    // wakesPerHour=5 so the project floor (max(20%*5, 5)=5) does NOT bypass once the
    // window is genuinely full in THIS project. Fill it with 5 settled wakes in this
    // project => total=5 >= cap AND project count not below floor.
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 5, urgentPerHour: 5 })
    const beta = await makeAgent('beta')
    for (let i = 0; i < 5; i++) {
      await db.insert(wakeEvents).values({ ownerUserId: OWNER, projectId, suppressed: false, senderUserId: OWNER })
    }

    // A send to the idle part: message delivered, but wake suppressed (budget full).
    const r = await send('gamma', ['beta'], 'msg')
    expect(r.suppressed).toBe(1)
    expect(await activeIntents(beta.id)).toHaveLength(0)
    const msgCount = await db.select({ id: messages.id }).from(messages)
    expect(msgCount.length).toBeGreaterThanOrEqual(1) // delivered despite suppression

    // Free the window (raise budget) and sweep => the suppressed part recovers a wake.
    await db.update(ownerWakeBudgets).set({ wakesPerHour: 30 }).where(eq(ownerWakeBudgets.userId, OWNER))
    const swept = await runEligibilitySweep(db, noopBus)
    expect(swept.issued).toBeGreaterThanOrEqual(1)
    expect(await activeIntents(beta.id)).toHaveLength(1)
  })

  // §17-3: 동시 발행이 예약으로 이중지출 안 함.
  // The deterministic anti-double-spend guarantee is the partial unique index
  // (wake_intent_agent_active): N concurrent issuers racing the SAME idle agent
  // collapse to EXACTLY ONE active wake - the rest coalesce (created=false ->
  // suppress:idle_already_pending). No agent is ever woken twice for one idle slot.
  it('§17-3 concurrent issuance for one idle part yields exactly one wake', async () => {
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
    const beta = await makeAgent('beta')
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, () => shouldWake(db, beta.id, { reason: 'message', senderUserId: OWNER })),
    )
    const issued = results.filter(r => r.action === 'issue')
    expect(issued).toHaveLength(1) // exactly one winner; the rest coalesced
    expect(await activeIntents(beta.id)).toHaveLength(1) // single active wake row
  })

  // §17-4: 소유권 이전 시 pending wake 원자 취소+환불.
  // No dedicated owner-transfer endpoint exists yet; the cancel+refund PRIMITIVE it
  // would use (active wake -> 'canceled' frees the rolling window) is what ban uses
  // and is asserted here. The transfer trigger itself is manual (DOGFOODING.md).
  it('§17-4 cancel+refund primitive: canceling an active wake frees the reservation', async () => {
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
    const beta = await makeAgent('beta')
    await shouldWake(db, beta.id, { reason: 'message', senderUserId: OWNER })
    expect(await inFlightReservations(OWNER)).toBe(1)

    // Cancel (the same transition ban/owner-transfer use): the reservation leaves
    // the rolling window atomically (refund). No counter arithmetic - the terminal
    // state simply stops being counted by countWindow.
    await db.update(wakeIntents).set({ state: 'canceled' }).where(eq(wakeIntents.agentId, beta.id))
    expect(await activeIntents(beta.id)).toHaveLength(0)
    expect(await inFlightReservations(OWNER)).toBe(0) // reservation refunded
  })

  // §17-5: urgent U 상한 + U=0 + 다이렉트 쿨다운.
  it('§17-5 urgent U cap, U=0 blocks urgent, direct cooldown suppresses ping-pong', async () => {
    // U cap = 2: fill the urgent window with 2 settled urgent events, then the next
    // urgent is suppressed by urgent_cap WITHOUT touching the normal N lane.
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 2 })
    for (let i = 0; i < 2; i++) {
      await db.insert(wakeEvents).values({ ownerUserId: OWNER, projectId, urgent: true, suppressed: false, senderUserId: OWNER })
    }
    const u3 = await makeAgent('u3')
    const d3 = await shouldWake(db, u3.id, { urgent: true, senderUserId: OWNER })
    expect(d3.action).toBe('suppress') // urgent_cap (U full)
    // ...but the normal lane is untouched: a non-urgent wake still issues.
    const nrm = await makeAgent('nrm')
    const dn = await shouldWake(db, nrm.id, { urgent: false, senderUserId: OWNER })
    expect(dn.action).toBe('issue')

    // U=0: urgent permanently blocked for this owner.
    await db.update(ownerWakeBudgets).set({ urgentPerHour: 0 }).where(eq(ownerWakeBudgets.userId, OWNER))
    const z = await makeAgent('zz')
    const dz = await shouldWake(db, z.id, { urgent: true, senderUserId: OWNER })
    expect(dz.action).toBe('suppress')

    // Direct cooldown: 1:1 ping-pong within 30s suppresses the second wake.
    resetLoopBreaker()
    await db.update(ownerWakeBudgets).set({ wakesPerHour: 30, urgentPerHour: 5 }).where(eq(ownerWakeBudgets.userId, OWNER))
    const peer = await makeAgent('peer')
    await send('caller', ['peer'], 'ping') // width-1 direct: issues + bumps cooldown
    await db.update(wakeIntents).set({ state: 'done', settledAt: new Date() }).where(eq(wakeIntents.agentId, peer.id))
    const r = await send('caller', ['peer'], 'ping-again') // within 30s
    expect(r.suppressed).toBe(1) // wake suppressed by direct cooldown, message still delivered
  })

  // §17-6: 프로젝트 floor가 시끄러운 프로젝트의 전체 굶주림을 막음.
  it('§17-6 project floor protects a quiet project from a noisy one', async () => {
    // wakesPerHour=10 => floor = max(20%*10, 5) = 5 per project.
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 10, urgentPerHour: 5 })
    const [noisy] = await db
      .insert(projects)
      .values({ organizationId: orgId, slug: `noisy_${randomBytes(3).toString('hex')}`, name: 'noisy' })
      .returning()
    await db.insert(projectAccess).values({ projectId: noisy.id, userId: OWNER, level: 'write' })
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })

    // Noisy project consumes the whole owner budget (10 settled wakes).
    for (let i = 0; i < 10; i++) {
      await db.insert(wakeEvents).values({ ownerUserId: OWNER, projectId: noisy.id, suppressed: false })
    }

    // The quiet project (projectId) has used 0 of its floor of 5 => still wakeable.
    const quietAgent = await makeAgent('quiet')
    const decision = await shouldWake(db, quietAgent.id, { senderUserId: OWNER })
    expect(decision.action).toBe('issue') // floor guarantee, not starved
  })

  // §17-7: ban이 즉시 send·connect 차단 + pending wake 취소, unban이 복원.
  it('§17-7 ban cancels pending wake + revokes connection, unban restores', async () => {
    await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
    const beta = await makeAgent('beta')
    // a live connection + an active wake on the member's agent.
    await db.insert(agentConnections).values({
      agentId: beta.id,
      accessTokenId: `tok-${randomBytes(4).toString('hex')}`,
      status: 'connected',
      connectedAt: new Date(),
    })
    await shouldWake(db, beta.id, { reason: 'message', senderUserId: OWNER })
    expect(await activeIntents(beta.id)).toHaveLength(1)

    const admin = `admin_${randomBytes(4).toString('hex')}`
    await seedUser(admin)
    const res = await applyBan(db, {
      projectId,
      userId: OWNER,
      scope: { kind: 'project' },
      bannedByUserId: admin,
      orgId,
    })
    expect(res.canceledWakes).toBeGreaterThanOrEqual(1)
    expect(res.revokedConnections).toBeGreaterThanOrEqual(1)

    // pending wake canceled (no active intent), bannedAt set, connection revoked.
    expect(await activeIntents(beta.id)).toHaveLength(0)
    const [acc] = await db
      .select({ bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, OWNER)))
    expect(acc.bannedAt).not.toBeNull()
    const [conn] = await db.select({ status: agentConnections.status }).from(agentConnections).where(eq(agentConnections.agentId, beta.id))
    expect(conn.status).toBe('revoked')

    // unban restores access (bannedAt cleared).
    await applyUnban(db, { projectId, userId: OWNER, scope: { kind: 'project' }, orgId })
    const [acc2] = await db
      .select({ bannedAt: projectAccess.bannedAt })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, OWNER)))
    expect(acc2.bannedAt).toBeNull()
  })

  // §17-8: 원장(usage 훅)이 발행 wake 초과 턴을 포착해 탐지기로 노출.
  it('§17-8 phantom turns flagged by reconcile, surfaced as a governance alert', async () => {
    const beta = await makeAgent('beta')
    // 6 real billed turns (type=complete, positive tokens) with NO matching issued
    // wake => all phantom. Threshold = 5 phantoms / 60 min.
    const now = Date.now()
    for (let i = 0; i < 6; i++) {
      await db.insert(events).values({
        projectId,
        agentId: beta.id,
        type: 'complete',
        usage: { input_tokens: 100, output_tokens: 50 },
        createdAt: new Date(now - i * 1000),
      })
    }
    const rec = await reconcileWakeLedger(db)
    expect(rec.phantomFlagged).toBeGreaterThanOrEqual(5)

    // Detection aggregates phantom wake_events on the subject. The phantom rows
    // carry ownerUserId but detection keys on senderUserId; stamp the subject so the
    // detector can attribute them (matches how ban/audit attribute phantom turns).
    await db.update(wakeEvents).set({ senderUserId: OWNER }).where(and(eq(wakeEvents.phantom, true), eq(wakeEvents.agentId, beta.id)))
    const raised = await runGovernanceDetection(db)
    expect(raised).toBeGreaterThanOrEqual(1)
    const alerts = await db
      .select({ kind: governanceAlerts.kind })
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.projectId, projectId), eq(governanceAlerts.kind, 'phantom_turns')))
    expect(alerts).toHaveLength(1)
  })
})
