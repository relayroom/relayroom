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

  it('leaves no durable claim that would outlive a correction', async () => {
    // The companion property: had the stale patterns won, this row would be the reason
    // the mistake could not be undone. Asserted so a future change that keeps the claim
    // but loses the fresh read is not silently acceptable.
    const [claim] = await db.execute<{ reason: string }>(sql`
      select reason from thread_extraction where project_id = ${second.id}
    `)
    expect(claim?.reason).toBe('extracted')
    expect(await storedBody(second.id)).not.toContain(SECRET)
  })
})
