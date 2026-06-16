import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { createDb, type Db } from '@relayroom/db'
import {
  agents,
  authSchema,
  directCooldowns,
  messageRecipients,
  messages,
  ownerWakeBudgets,
  projectAccess,
  projects,
  threads,
  wakeEvents,
  wakeIntents,
} from '@relayroom/db'
import {
  CapabilityError,
  getCapabilities,
  hasCapability,
  resolveUrgent,
} from '../src/priority/capability'
import {
  checkAndBumpDirectCooldown,
  DIRECT_COOLDOWN_MS,
} from '../src/priority/direct-cooldown'
import { dispatch } from '../src/wake/pipeline'
import { resetLoopBreaker } from '../src/wake/pipeline'
import { ACTIVE_WAKE_STATES } from '../src/wake/state'

const TEST_DATABASE_URL = 'postgres://hub:hub@localhost:48802/hub_test'
const db: Db = createDb(TEST_DATABASE_URL)

const OWNER = 'user_owner_06'
let projectId: string
let projectSlug: string

async function seedUser(id: string): Promise<void> {
  await db
    .insert(authSchema.better_auth_user)
    .values({ id, name: id, email: `${id}@test.local`, emailVerified: true })
    .onConflictDoNothing()
}

async function freshAgent(part: string, owner: string | null = OWNER): Promise<string> {
  const [a] = await db
    .insert(agents)
    .values({ projectId, part, ownerUserId: owner })
    .returning()
  return a.id
}

async function activeIntents(aid: string) {
  return db
    .select({ id: wakeIntents.id })
    .from(wakeIntents)
    .where(and(eq(wakeIntents.agentId, aid), inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[])))
}

function countUrgent(rows: { urgent: boolean; suppressed: boolean }[], urgent: boolean) {
  return rows.filter(r => r.suppressed === false && r.urgent === urgent).length
}

const noopEmit = () => {}

beforeEach(async () => {
  resetLoopBreaker()
  await db.delete(directCooldowns)
  await db.delete(wakeEvents)
  await db.delete(wakeIntents)
  await db.delete(messageRecipients)
  await db.delete(messages)
  await db.delete(threads)
  await db.delete(agents)
  await db.delete(projectAccess)
  await db.delete(ownerWakeBudgets)
  await db.delete(projects)
  await db.delete(authSchema.better_auth_user).where(eq(authSchema.better_auth_user.id, OWNER))

  await seedUser(OWNER)
  const [p] = await db
    .insert(projects)
    .values({ organizationId: 'org_06', slug: 's06', name: 'P06' })
    .returning()
  projectId = p.id
  projectSlug = p.slug
  await db.insert(ownerWakeBudgets).values({ userId: OWNER, wakesPerHour: 30, urgentPerHour: 5 })
})

afterAll(async () => {
  await db.$client.end()
})

// ── Task 2: capability helpers ────────────────────────────────────────────────

describe('capability', () => {
  it('resolveUrgent: true when the member has the urgent capability', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write', capabilities: ['urgent'] })
    const caps = await getCapabilities(db, projectId, OWNER)
    expect(hasCapability(caps, 'urgent')).toBe(true)
    expect(resolveUrgent(caps, true)).toBe(true)
  })

  it('resolveUrgent: throws CapabilityError when the urgent capability is absent', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
    const caps = await getCapabilities(db, projectId, OWNER)
    expect(() => resolveUrgent(caps, true)).toThrow(CapabilityError)
  })

  it('resolveUrgent: false (no throw) when not requested, regardless of capability', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
    const caps = await getCapabilities(db, projectId, OWNER)
    expect(resolveUrgent(caps, false)).toBe(false)
    expect(resolveUrgent(caps, undefined)).toBe(false)
  })

  it('getCapabilities: empty set when no project_access row exists', async () => {
    const caps = await getCapabilities(db, projectId, 'nobody')
    expect(caps.size).toBe(0)
  })
})

// ── Task 4: urgent draws U, not N; U=0 suppresses but delivers ─────────────────

describe('urgent budget routing', () => {
  it('urgent send consumes U, leaves the normal N counter untouched', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write', capabilities: ['urgent'] })
    const recipient = await freshAgent('beta')
    const fromAgent = await freshAgent('alpha')

    const r = await dispatch(db, {
      projectId,
      projectSlug,
      threadId: (await db.insert(threads).values({ projectId, subject: 's' }).returning())[0]!.id,
      subject: 's',
      fromPart: 'alpha',
      fromAgentId: fromAgent,
      fromUserId: OWNER,
      connectionId: 'conn-a',
      body: 'hi',
      urgent: true,
      recipientsSpec: { mode: 'send', to: ['beta'] },
      maxBroadcastRecipients: null,
      emit: noopEmit,
    })
    expect(r.suppressed).toBe(0)

    const rows = await db
      .select({ urgent: wakeEvents.urgent, suppressed: wakeEvents.suppressed })
      .from(wakeEvents)
      .where(eq(wakeEvents.ownerUserId, OWNER))
    // exactly one issued urgent control row, zero normal-lane rows.
    expect(countUrgent(rows, true)).toBe(1)
    expect(countUrgent(rows, false)).toBe(0)
    // the issued wake_intent is marked urgent.
    const [intent] = await db.select({ urgent: wakeIntents.urgent }).from(wakeIntents).where(eq(wakeIntents.agentId, recipient))
    expect(intent!.urgent).toBe(true)
    // message row denormalizes urgent=true.
    const [msg] = await db.select({ urgent: messages.urgent }).from(messages)
    expect(msg!.urgent).toBe(true)
  })

  it('U=0 suppresses even an urgent wake but still delivers the message', async () => {
    await db.update(ownerWakeBudgets).set({ urgentPerHour: 0 }).where(eq(ownerWakeBudgets.userId, OWNER))
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write', capabilities: ['urgent'] })
    const recipient = await freshAgent('beta')
    const fromAgent = await freshAgent('alpha')
    const [thread] = await db.insert(threads).values({ projectId, subject: 's' }).returning()

    const r = await dispatch(db, {
      projectId,
      projectSlug,
      threadId: thread.id,
      subject: 's',
      fromPart: 'alpha',
      fromAgentId: fromAgent,
      fromUserId: OWNER,
      connectionId: 'conn-a',
      body: 'hi',
      urgent: true,
      recipientsSpec: { mode: 'send', to: ['beta'] },
      maxBroadcastRecipients: null,
      emit: noopEmit,
    })
    expect(r.suppressed).toBe(1)

    // delivered: messageRecipients row exists.
    const recips = await db.select().from(messageRecipients).where(eq(messageRecipients.agentId, recipient))
    expect(recips).toHaveLength(1)
    // suppressed: no active wake_intent.
    expect(await activeIntents(recipient)).toHaveLength(0)
    // normal N lane untouched (urgent_zero is a urgent-lane denial).
    const rows = await db
      .select({ urgent: wakeEvents.urgent, suppressed: wakeEvents.suppressed })
      .from(wakeEvents)
      .where(eq(wakeEvents.ownerUserId, OWNER))
    expect(countUrgent(rows, false)).toBe(0)
  })
})

// ── Task 5: direct (width-1) cooldown ──────────────────────────────────────────

describe('direct cooldown helper', () => {
  it('blocks a 2nd bump within the window, allows again after it elapses', async () => {
    const s = await freshAgent('s')
    const r = await freshAgent('r')
    const t0 = new Date()
    expect((await checkAndBumpDirectCooldown(db, s, r, projectId, t0)).allowed).toBe(true)
    const t1 = new Date(t0.getTime() + 1000)
    expect((await checkAndBumpDirectCooldown(db, s, r, projectId, t1)).allowed).toBe(false)
    const t2 = new Date(t0.getTime() + DIRECT_COOLDOWN_MS + 1)
    expect((await checkAndBumpDirectCooldown(db, s, r, projectId, t2)).allowed).toBe(true)
  })
})

describe('direct cooldown in dispatch', () => {
  async function directSend(fromAgentId: string, body: string) {
    const [thread] = await db.insert(threads).values({ projectId, subject: 'd' }).returning()
    return dispatch(db, {
      projectId,
      projectSlug,
      threadId: thread.id,
      subject: 'd',
      fromPart: 'alpha',
      fromAgentId,
      fromUserId: OWNER,
      connectionId: 'conn-a',
      body,
      urgent: false,
      recipientsSpec: { mode: 'send', to: ['beta'] },
      maxBroadcastRecipients: null,
      emit: noopEmit,
    })
  }

  it('blocks the 2nd width-1 wake within 30s, but still delivers the message', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
    const recipient = await freshAgent('beta')
    const fromAgent = await freshAgent('alpha')

    const r1 = await directSend(fromAgent, 'first')
    expect(r1.suppressed).toBe(0)
    expect(await activeIntents(recipient)).toHaveLength(1)

    const r2 = await directSend(fromAgent, 'second')
    // wake suppressed (still only the 1st active intent), but delivered.
    expect(r2.suppressed).toBe(1)
    expect(await activeIntents(recipient)).toHaveLength(1)
    const recips = await db.select().from(messageRecipients).where(eq(messageRecipients.agentId, recipient))
    expect(recips).toHaveLength(2) // both messages delivered
    // suppressed control row recorded for the cooldown block.
    const suppressed = await db
      .select({ id: wakeEvents.id })
      .from(wakeEvents)
      .where(and(eq(wakeEvents.agentId, recipient), eq(wakeEvents.suppressed, true)))
    expect(suppressed).toHaveLength(1)
  })

  it('does not apply the cooldown to width-2 broadcasts', async () => {
    await db.insert(projectAccess).values({ projectId, userId: OWNER, level: 'write' })
    const b = await freshAgent('beta')
    const g = await freshAgent('gamma')
    const fromAgent = await freshAgent('alpha')
    const [thread] = await db.insert(threads).values({ projectId, subject: 'b' }).returning()

    const r = await dispatch(db, {
      projectId,
      projectSlug,
      threadId: thread.id,
      subject: 'b',
      fromPart: 'alpha',
      fromAgentId: fromAgent,
      fromUserId: OWNER,
      connectionId: 'conn-a',
      body: 'hi',
      urgent: false,
      recipientsSpec: { mode: 'send', to: ['beta', 'gamma'] },
      maxBroadcastRecipients: null,
      emit: noopEmit,
    })
    expect(r.suppressed).toBe(0)
    expect(await activeIntents(b)).toHaveLength(1)
    expect(await activeIntents(g)).toHaveLength(1)
    // no cooldown rows written for a broadcast.
    expect(await db.select().from(directCooldowns)).toHaveLength(0)
  })
})

// ── Task 6: needsHuman is a tag-only lane, never an agent wake ──────────────────
// The capability GATE itself lives in the mcp.ts send/reply handlers (which need a
// full OAuth/connection context); here we assert the invariant the gate protects:
// the needs-human tag is a thread tag, completely separate from the wake pipeline.

describe('needsHuman human-lane separation', () => {
  it('the needs-human tag is a thread tag that does not ride the wake pipeline', async () => {
    // A thread tagged needs-human with no message dispatch issues zero wakes.
    const [thread] = await db
      .insert(threads)
      .values({ projectId, subject: 'help', tags: ['needs-human'] })
      .returning()
    const found = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.status, 'open')))
    expect(found.map(t => t.id)).toContain(thread.id)
    // zero wake_intents exist: the bell is a tag, not a wake.
    expect(await db.select().from(wakeIntents)).toHaveLength(0)
  })
})
