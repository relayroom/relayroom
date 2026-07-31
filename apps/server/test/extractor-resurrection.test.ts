/**
 * BUG-0010: the extractor must not resurrect knowledge that was deliberately removed.
 *
 * The defect: the sweep's only record that a thread had been extracted was the
 * EXISTENCE of a knowledge row citing it. Retention's hard delete and
 * `purgeKnowledgeFromThread` both remove that row while the thread's messages remain,
 * so the next sweep re-extracted and wrote the candidate back. For purge - the
 * operator's remedy for a leaked secret - the remedy silently undid itself.
 *
 * WHY EVERY TEST HERE RE-DIRTIES THE PROJECT, and why that is the point rather than
 * boilerplate. The sweep only processes projects whose dirty marker is set, and a
 * successful extraction clears it. NEITHER purge NOR retention raises it again. So
 * the obvious test - purge, then run the sweep, then assert nothing came back - passes
 * on the BROKEN code by doing no work at all. It would have been green before the fix
 * and green after it, proving nothing. Every resurrection case below therefore closes
 * another thread to re-dirty the project, and asserts `projects === 1` so a sweep that
 * silently skipped cannot be mistaken for a sweep that correctly declined.
 *
 * That is also the real mechanism, not a test artifact: a purged thread comes back
 * when the NEXT thread closes in that project, since the marker is project-level.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import {
  agents,
  knowledge,
  markProjectKnowledgeDirty,
  messages,
  projects,
  purgeKnowledgeFromThread,
  threadExtractions,
  threads,
} from '@relayroom/db'
import { better_auth_user } from '@relayroom/db/auth-schema'
import { runExtractorSweep } from '../src/knowledge/extractor-sweep'
import { makeTestApp } from './helpers'

const { db, bus } = makeTestApp()

afterAll(async () => {
  await bus.close()
  await db.$client.end()
})

const USER = `usr-res-${randomBytes(4).toString('hex')}`
beforeAll(async () => {
  await db.insert(better_auth_user)
    .values({ id: USER, name: 'Resurrection Tester', email: `${USER}@test.local` })
    .onConflictDoNothing()
})

async function project(): Promise<{ id: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `rs-org-${sfx}`, slug: `rs-${sfx}`, name: 'Resurrection', connectCode: `rs-cc-${sfx}`,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
  return { id: p!.id, agentId: a!.id }
}

/** A closed thread carrying one substantive agent message. */
async function closedThread(projectId: string, agentId: string, body = 'the lesson'): Promise<string> {
  const [t] = await db.insert(threads)
    .values({ projectId, subject: `subj-${randomBytes(3).toString('hex')}`, status: 'closed' })
    .returning({ id: threads.id })
  await db.insert(messages).values({ threadId: t!.id, fromAgentId: agentId, body })
  return t!.id
}

/** Re-dirty by closing another thread - the real trigger, not a synthetic marker. */
async function reDirty(projectId: string, agentId: string): Promise<void> {
  await closedThread(projectId, agentId, 'unrelated later work that also has substance')
  await markProjectKnowledgeDirty(db, projectId)
}

async function watermark(projectId: string, threadId: string): Promise<string | null> {
  const [row] = await db.select({ reason: threadExtractions.reason }).from(threadExtractions)
    .where(and(eq(threadExtractions.projectId, projectId), eq(threadExtractions.threadId, threadId)))
  return row?.reason ?? null
}

describe('extractor resurrection (BUG-0010)', () => {
  it('does not recreate a candidate after the thread was purged', async () => {
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)

    await markProjectKnowledgeDirty(db, p)
    const first = await runExtractorSweep(db, { projectId: p })
    expect(first.candidates).toBe(1)
    expect(await watermark(p, t)).toBe('extracted')

    await purgeKnowledgeFromThread(db, p, t, { actorUserId: USER })
    expect(await watermark(p, t)).toBe('purged')

    await reDirty(p, agentId)
    const second = await runExtractorSweep(db, { projectId: p })
    // The project WAS processed - otherwise this test proves nothing.
    expect(second.projects).toBe(1)
    // The unrelated thread is extracted; the purged one is not.
    expect(second.candidates).toBe(1)
    expect(await citesThread(p, t)).toHaveLength(0)
  })

  it('keeps a purged thread purged across many sweeps, not just the next one', async () => {
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await markProjectKnowledgeDirty(db, p)
    await runExtractorSweep(db, { projectId: p })
    await purgeKnowledgeFromThread(db, p, t, { actorUserId: USER })

    for (let i = 0; i < 3; i++) {
      // Re-dirty before EVERY iteration, or the later ones are vacuous.
      await reDirty(p, agentId)
      const r = await runExtractorSweep(db, { projectId: p })
      expect(r.projects).toBe(1)
      expect(await citesThread(p, t)).toHaveLength(0)
    }
  })

  it('does not recreate a candidate after its row was hard-deleted', async () => {
    // Retention's hard delete removes the row without touching the watermark. This
    // is the retention half of the same defect, exercised at the row level so it does
    // not depend on retention's own scheduling.
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await markProjectKnowledgeDirty(db, p)
    await runExtractorSweep(db, { projectId: p })

    const [row] = await citesThread(p, t)
    await db.delete(knowledge).where(eq(knowledge.id, row!.id))
    expect(await citesThread(p, t)).toHaveLength(0)
    expect(await watermark(p, t)).toBe('extracted') // the record outlives the evidence

    await reDirty(p, agentId)
    const r = await runExtractorSweep(db, { projectId: p })
    expect(r.projects).toBe(1)
    expect(await citesThread(p, t)).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a thread that was never extracted is still extracted normally', async () => {
    // Without this, a guard that suppresses everything passes every test above.
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await markProjectKnowledgeDirty(db, p)
    const r = await runExtractorSweep(db, { projectId: p })
    expect(r.projects).toBe(1)
    expect(await citesThread(p, t)).toHaveLength(1)
    expect(await watermark(p, t)).toBe('extracted')
  })

  it('NEGATIVE CONTROL: a thread that extracts to nothing gets no watermark and is re-evaluated', async () => {
    // "Emitted nothing" is the current output of a function over inputs that change -
    // redaction patterns are editable config. Marking it would convert "no lesson
    // found yet" into "never look again" on exactly the threads a corrected pattern
    // would recover. So: no watermark, and it comes back when the pattern is fixed.
    const sfx = randomBytes(6).toString('hex')
    const [p] = await db.insert(projects).values({
      organizationId: `rn-org-${sfx}`, slug: `rn-${sfx}`, name: 'Nothing', connectCode: `rn-cc-${sfx}`,
      knowledgeConfig: { redactionRules: [{ kind: 'literal', value: 'SECRET-BODY' }] },
    }).returning({ id: projects.id })
    const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })

    const t = await closedThread(p!.id, a!.id, 'SECRET-BODY')
    await markProjectKnowledgeDirty(db, p!.id)
    const first = await runExtractorSweep(db, { projectId: p!.id })
    expect(first.projects).toBe(1)
    expect(await citesThread(p!.id, t)).toHaveLength(0)
    expect(await watermark(p!.id, t)).toBeNull() // not foreclosed

    // The operator fixes the over-broad pattern. The thread must become extractable.
    await db.update(projects).set({ knowledgeConfig: { redactionRules: [] } })
      .where(eq(projects.id, p!.id))
    await markProjectKnowledgeDirty(db, p!.id)
    const second = await runExtractorSweep(db, { projectId: p!.id })
    expect(second.projects).toBe(1)
    expect(await citesThread(p!.id, t)).toHaveLength(1)
  })

  it('the watermark is the whole guard - remove it and the same thread is extracted again', async () => {
    // REWRITTEN when the `source_refs` predicate was removed, and the flip is the point
    // rather than a detail. This case used to delete the watermark, assert the thread was
    // still suppressed, and call that "the backfill covered pre-existing rows" - but what
    // suppressed it was the predicate, not the backfill, and deleting the watermark is the
    // inverse of the state the backfill produces. It was passing for a reason it did not
    // name.
    //
    // What it asserts now is what actually holds: the watermark is the only record of a
    // decision, so removing it makes the thread extractable again. That the backfill puts
    // one there for every pre-0022 extractor row is a property of migration 0022 and is
    // tested against the migration's own SQL in packages/db - not here, and not by this.
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await markProjectKnowledgeDirty(db, p)
    await runExtractorSweep(db, { projectId: p })
    expect(await citesThread(p, t)).toHaveLength(1)

    await db.delete(threadExtractions)
      .where(and(eq(threadExtractions.projectId, p), eq(threadExtractions.threadId, t)))
    expect(await watermark(p, t)).toBeNull()

    await reDirty(p, agentId)
    const r = await runExtractorSweep(db, { projectId: p })
    expect(r.projects).toBe(1)
    // Two now: the original candidate and a second one. Nothing else was holding it.
    expect(await citesThread(p, t)).toHaveLength(2)
  })
})

/**
 * A CITATION IS NOT A DECISION, which is what removing the `source_refs` predicate
 * settled.
 *
 * The predicate skipped any thread that a knowledge row cited. That covered two very
 * different things: rows the extractor wrote (already decided) and rows `learn` wrote
 * (someone mentioned the thread). Only the first is a decision, and the watermark
 * records exactly that - so the predicate went, and a `learn` row citing a thread no
 * longer stops it being extracted. Both rows existing is correct: different acts,
 * different content.
 *
 * Two places had already settled this before the predicate went: migration 0022's
 * backfill deliberately excludes `learn` rows, and the release contract's acceptance net
 * allows `learn` rows citing an extracted thread.
 *
 * The pair below is the flipped claim AND its support. The first says a citation does
 * not suppress; the second says the watermark does. Written together on purpose - after
 * a rewrite that changes WHAT a test leans on, the new support has to be shown to hold,
 * or "we rewrote it green" and "we found what actually guards it" look identical.
 */
describe('a citation is not a decision', () => {
  /** What `learn` with a sourceThreadId writes: source_kind 'learn', citing the thread,
   *  and NO watermark. Migration 0022's backfill deliberately leaves these alone. */
  async function learnRow(projectId: string, threadId: string) {
    await db.insert(knowledge).values({
      projectId, kind: 'pitfall', title: 'what an agent recorded',
      body: 'a lesson an agent wrote while the thread was still open',
      sourceKind: 'learn', sourceRefs: [{ threadId }], validationState: 'candidate',
    })
  }

  it('extracts a thread that only a learn row cites', async () => {
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await learnRow(p, t)
    expect(await watermark(p, t)).toBeNull()

    await markProjectKnowledgeDirty(db, p)
    const r = await runExtractorSweep(db, { projectId: p })
    // The project WAS processed - without this the assertion below is satisfied by a
    // sweep that did nothing at all.
    expect(r.projects).toBe(1)
    // Two rows, and that is the intended outcome: the agent's lesson and the extractor's
    // candidate. One-time effect on an existing installation - 8 threads on the
    // production hub when this shipped.
    expect(await citesThread(p, t)).toHaveLength(2)
    expect(await watermark(p, t)).toBe('extracted')
  })

  it('and does not once the watermark is there, learn row or not', async () => {
    // THE SUPPORT the test above now leans on, and the negative control for the rewrite:
    // delete the claim in extractProject and this goes red, which is what says the
    // watermark is carrying the weight the predicate used to.
    const { id: p, agentId } = await project()
    const t = await closedThread(p, agentId)
    await markProjectKnowledgeDirty(db, p)
    await runExtractorSweep(db, { projectId: p })
    expect(await watermark(p, t)).toBe('extracted')
    expect(await citesThread(p, t)).toHaveLength(1)

    // A learn row arriving afterwards changes nothing either way.
    await learnRow(p, t)
    await reDirty(p, agentId)
    const r = await runExtractorSweep(db, { projectId: p })
    expect(r.projects).toBe(1)
    // Two: the original candidate and the learn row. A third would be the resurrection.
    expect(await citesThread(p, t)).toHaveLength(2)
  })
})

/** Knowledge rows in this project citing this thread. */
async function citesThread(projectId: string, threadId: string) {
  return db.execute<{ id: string }>(sql`
    select id from knowledge
     where project_id = ${projectId}
       and source_refs @> ${JSON.stringify([{ threadId }])}::jsonb
  `)
}
