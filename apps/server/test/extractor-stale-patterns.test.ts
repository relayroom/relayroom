/**
 * The sweep must redact with the patterns that are current when it writes, not with the
 * ones that were current when it picked the project up.
 *
 * THE HAZARD, which is why this is not a style question. A candidate write leaves a
 * durable `thread_extraction` claim, so the thread is never reconsidered. If the sweep
 * redacts with a stale pattern list, it stores the secret the owner has already written a
 * pattern for AND permanently marks the thread as handled. Editing the pattern afterwards
 * does not recover it: the claim is what the next sweep checks. So the window between
 * reading the patterns and writing the row is the whole difference between "the owner's
 * fix works" and "the owner's fix silently arrived too late, forever".
 *
 * The window was real: the patterns were read in the outer project query, before the
 * advisory lock, while the dirty marker was re-read under it. The marker being fresh did
 * not help - the sweep saw the new marker and used the old patterns.
 *
 * HOW THIS TEST REACHES THE WINDOW WITHOUT INSTRUMENTING THE SWEEP. The outer query
 * snapshots every dirty project at once and the loop then processes them one at a time,
 * so a change committed while project A is being processed lands inside project B's
 * window. A database trigger on the knowledge insert is what commits it - no hook in the
 * application, and no sleep: the ordering is enforced by the sweep's own loop.
 *
 * Mutation-checked: restoring the pattern read to the outer query fails this test with
 * the secret present in B's stored body, and leaves every other extractor test green.
 * Found by review loop 6 of the extraction-quality design.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { agents, knowledge, markProjectKnowledgeDirty, messages, projects, threads } from '@relayroom/db'
import { runExtractorSweep } from '../src/knowledge/extractor-sweep'
import { makeTestApp } from './helpers'

const { db, bus } = makeTestApp()

const SECRET = `SEKRET-${randomBytes(4).toString('hex')}`
const TRIGGER = `stale_patterns_${randomBytes(4).toString('hex')}`

afterAll(async () => {
  await db.execute(sql.raw(`drop trigger if exists ${TRIGGER} on knowledge`))
  await db.execute(sql.raw(`drop function if exists ${TRIGGER}_fn()`))
  await bus.close()
  await db.$client.end()
})

async function project(patterns: string[]): Promise<{ id: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `sp-org-${sfx}`,
    slug: `sp-${sfx}`,
    name: 'Stale patterns',
    connectCode: `sp-cc-${sfx}`,
    knowledgeConfig: { redactionPatterns: patterns },
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
  return { id: p!.id, agentId: a!.id }
}

async function closedThread(projectId: string, agentId: string, body: string): Promise<string> {
  const [t] = await db.insert(threads)
    .values({ projectId, subject: `subj-${randomBytes(3).toString('hex')}`, status: 'closed' })
    .returning({ id: threads.id })
  await db.insert(messages).values({ threadId: t!.id, fromAgentId: agentId, body })
  return t!.id
}

async function storedBody(projectId: string): Promise<string> {
  const [row] = await db.select({ body: knowledge.body }).from(knowledge)
    .where(eq(knowledge.projectId, projectId))
  return row?.body ?? ''
}

describe('extractor: redaction patterns are read where the marker is read', () => {
  let first: { id: string; agentId: string }
  let second: { id: string; agentId: string }

  beforeAll(async () => {
    // A is sacrificial: its only job is to be processed first, so that the trigger its
    // candidate fires commits inside B's window.
    first = await project([])
    second = await project([])
    await closedThread(first.id, first.agentId, 'an ordinary lesson with no secret in it')
    await closedThread(second.id, second.agentId, `the answer is ${SECRET} and that is the lesson`)

    // The owner edits B's patterns while the sweep is mid-tick. Written as a trigger on
    // A's candidate insert so the commit lands at a deterministic point in the loop.
    await db.execute(sql.raw(`
      create or replace function ${TRIGGER}_fn() returns trigger as $$
      begin
        if new.project_id = '${first.id}' then
          update project
             set knowledge_config = jsonb_build_object('redactionPatterns', jsonb_build_array('${SECRET}'))
           where id = '${second.id}';
        end if;
        return new;
      end $$ language plpgsql;
    `))
    await db.execute(sql.raw(`
      create trigger ${TRIGGER} after insert on knowledge
      for each row execute function ${TRIGGER}_fn()
    `))

    // A first, so the loop reaches it before B.
    await markProjectKnowledgeDirty(db, first.id)
    await markProjectKnowledgeDirty(db, second.id)
  })

  it('redacts with the patterns committed after the tick began, not the ones it started with', async () => {
    // Unpinned: both projects must come out of ONE outer query for the window to exist.
    const result = await runExtractorSweep(db)

    // Both projects were actually processed. Without this the test could pass by doing
    // nothing at all - the failure mode every test in extractor-resurrection.test.ts is
    // built to rule out.
    expect(result.projects).toBeGreaterThanOrEqual(2)
    expect(await storedBody(first.id)).toContain('ordinary lesson')

    const body = await storedBody(second.id)
    expect(body).not.toBe('')
    expect(body).not.toContain(SECRET)
    // The rest of the lesson survives - redaction drops the matched span, so this
    // distinguishes "the pattern was applied" from "extraction produced nothing".
    expect(body).toContain('the answer is')
  })

  it('writes the durable claim that would have made a stale redaction permanent', async () => {
    // Named for what it asserts. An earlier title said "leaves no durable claim" while
    // asserting a claim EXISTS - review loop 7 caught it, and a test whose name contradicts
    // its body is worse than no test, because the name is what a later reader trusts.
    //
    // The claim is correct here and is also the reason the fresh read matters: once this
    // row exists the thread is never reconsidered, so whatever patterns were in force at
    // write time are the ones that thread lives with forever.
    const [claim] = await db.execute<{ reason: string }>(sql`
      select reason from thread_extraction where project_id = ${second.id}
    `)
    expect(claim?.reason).toBe('extracted')
    expect(await storedBody(second.id)).not.toContain(SECRET)
  })
})

/**
 * The window the advisory lock does NOT close, and the row lock does.
 *
 * The advisory lock excludes other sweep workers - nothing else in the system takes it -
 * so a settings save can commit between the sweep's read and its candidate insert. The
 * first fix moved the read under the advisory lock; that alone left this second window
 * open, which review loop 7 pointed out before any of it shipped. Both writers touch the
 * project row, so `for update` on it is the serialization point they actually share.
 *
 * This test does not simulate the interleaving with a sleep. It holds the row lock from a
 * SECOND CONNECTION, waits until Postgres reports the sweep is actually blocked on a lock
 * (`pg_stat_activity.wait_event_type = 'Lock'`), and only then commits. The wait check is
 * the point: without it, a sweep that had not yet reached the read would pass for the
 * wrong reason.
 *
 * Mutation-checked: dropping `for update` fails this test with the secret stored, because
 * the sweep reads the pre-update config instead of waiting for the new one.
 */
describe('extractor: a settings write during the sweep is serialized, not lost', () => {
  const SECRET2 = `SEKRET2-${randomBytes(4).toString('hex')}`

  it('waits on the project row and redacts with the patterns that writer committed', { timeout: 30_000 }, async () => {
    const p = await project([])
    await closedThread(p.id, p.agentId, `deploy key ${SECRET2} do not paste`)
    await markProjectKnowledgeDirty(db, p.id)

    const writer = makeTestApp()
    try {
      // Two gates, so the interleaving is enforced rather than hoped for: the sweep does
      // not start until the settings update has actually executed (and therefore holds the
      // row), and the settings transaction does not commit until the sweep is observably
      // blocked on that row.
      let updateRan: () => void = () => {}
      let commitNow: () => void = () => {}
      const updated = new Promise<void>((r) => { updateRan = r })
      const release = new Promise<void>((r) => { commitNow = r })

      const held = writer.db.$client.begin(async (tx) => {
        await tx`update project
                    set knowledge_config = jsonb_build_object('redactionPatterns', jsonb_build_array(${SECRET2}::text))
                  where id = ${p.id}`
        updateRan()
        await release
      })

      await updated
      const swept = runExtractorSweep(db, { projectId: p.id })

      let sweepWasBlocked = false
      for (let i = 0; i < 100 && !sweepWasBlocked; i++) {
        const rows = await db.execute<{ q: string }>(sql`
          select query as q from pg_stat_activity
           where state = 'active' and wait_event_type = 'Lock'
        `)
        // Matched on `redactionPatterns`, which appears ONLY in the snapshot select. The
        // obvious filter - `knowledge_dirty_at::text` - also matches the marker-clearing
        // update at the end of the sweep, which blocks on the same row for the same reason
        // but AFTER the candidate has been written. That detector reported "blocked" on the
        // broken code too, i.e. it measured the wrong statement and would have made the
        // precondition meaningless.
        sweepWasBlocked = rows.some(r => r.q?.includes('redactionPatterns'))
        if (!sweepWasBlocked) await new Promise(r => setTimeout(r, 50))
      }
      commitNow()
      await held
      await swept

      // The precondition, asserted rather than assumed: if the sweep never waited, this
      // test proves nothing about serialization and must fail rather than pass quietly.
      expect(sweepWasBlocked).toBe(true)

      const body = await storedBody(p.id)
      expect(body).not.toContain(SECRET2)
      expect(body).toContain('deploy key')
    }
    finally {
      await writer.bus.close()
      await writer.db.$client.end()
    }
  })
})
