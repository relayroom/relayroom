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
    knowledgeConfig: { redactionRules: patterns.map(value => ({ kind: 'literal' as const, value })) },
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
             set knowledge_config = jsonb_build_object('redactionRules',
                   jsonb_build_array(jsonb_build_object('kind', 'literal', 'value', '${SECRET}')))
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
 * A settings save that lands mid-project stops the sweep instead of writing under the old
 * rule - and does it without any lock, because the comparison rides on the claim.
 *
 * The previous attempt at this took `for update` on the project row. That worked and was
 * withdrawn: it made the sweep take the project row before the per-thread watermark, while
 * the close path takes the watermark first, and two paths acquiring the same pair in
 * opposite orders deadlock. Review loop 8 found it in the window between the code shipping
 * and the close path being written.
 *
 * What replaced it is a comparison inside the claim: the insert happens only if the
 * project's patterns are still the ones the candidate was redacted with. The requirement
 * was never "serialize the two writers", it was "never write under a stale rule".
 *
 * Reaching it deterministically: two threads in ONE project. The first candidate's insert
 * fires a trigger that changes the patterns, so by the time the second thread is claimed the
 * comparison fails. No sleeps, no second connection, and no dependence on which order two
 * transactions happen to commit in.
 */
describe('extractor: a pattern change mid-project stops the sweep, without a lock', () => {
  const SECRET2 = `SEKRET2-${randomBytes(4).toString('hex')}`
  const TRIGGER2 = `mid_project_${randomBytes(4).toString('hex')}`

  afterAll(async () => {
    await db.execute(sql.raw(`drop trigger if exists ${TRIGGER2} on knowledge`))
    await db.execute(sql.raw(`drop function if exists ${TRIGGER2}_fn()`))
  })

  it('writes the first thread, refuses the second, and leaves the marker set', async () => {
    const p = await project([])
    // Ordered by insertion: the sweep processes threads in the eligibility query's order,
    // so the first one written is the one whose trigger fires.
    await closedThread(p.id, p.agentId, 'the first lesson, ordinary and safe')
    await closedThread(p.id, p.agentId, `the second lesson mentions ${SECRET2} in passing`)

    await db.execute(sql.raw(`
      create or replace function ${TRIGGER2}_fn() returns trigger as $$
      begin
        if new.project_id = '${p.id}' then
          update project
             set knowledge_config = jsonb_build_object('redactionRules',
                   jsonb_build_array(jsonb_build_object('kind', 'literal', 'value', '${SECRET2}')))
           where id = '${p.id}';
        end if;
        return new;
      end $$ language plpgsql;
    `))
    await db.execute(sql.raw(`
      create trigger ${TRIGGER2} after insert on knowledge
      for each row execute function ${TRIGGER2}_fn()
    `))

    await markProjectKnowledgeDirty(db, p.id)
    const first = await runExtractorSweep(db, { projectId: p.id })

    // One candidate written; the second thread was NOT claimed under the old patterns.
    expect(first.candidates).toBe(1)
    const [claims] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from thread_extraction where project_id = ${p.id}
    `)
    expect(claims?.n).toBe(1)

    // And the marker survives, which is the whole mechanism for "the rest gets redone".
    // Without it the second thread would be stranded: no claim, no candidate, no trigger
    // to look at it again.
    const [marker] = await db.execute<{ dirty: string | null }>(sql`
      select knowledge_dirty_at::text as dirty from project where id = ${p.id}
    `)
    expect(marker?.dirty).not.toBeNull()

    // The next tick, with the new patterns in force, finishes the job with the secret gone.
    await db.execute(sql.raw(`drop trigger if exists ${TRIGGER2} on knowledge`))
    const second = await runExtractorSweep(db, { projectId: p.id })
    expect(second.candidates).toBe(1)

    const bodies = await db.execute<{ body: string }>(sql`
      select body from knowledge where project_id = ${p.id}
    `)
    expect(bodies).toHaveLength(2)
    expect(bodies.map(b => b.body).join('\n')).not.toContain(SECRET2)
    expect(bodies.some(b => b.body.includes('the second lesson mentions'))).toBe(true)
  })
})

/**
 * A rule we cannot resolve stops the write, and the refusal is a deferral rather than a
 * loss.
 *
 * rrc-web proposed reporting an unresolvable detector instead of skipping it silently.
 * Reporting alone is not enough, and their own sentence is why: reporting is
 * observation, not protection - the row still gets stored while a protection the owner
 * switched on is not being applied. What the invariant forbids is the storage.
 *
 * So the write is refused. The part that makes that acceptable is the second assertion:
 * nothing is claimed, so fixing the catalogue lets the thread extract on a later tick.
 * That property is inherited from BUG-0010's decision not to watermark an empty
 * extraction, and this is the second feature to depend on it.
 */
describe('extractor: an unresolvable redaction rule refuses the write, recoverably', () => {
  it('writes nothing, claims nothing, and extracts once the rule resolves', async () => {
    const sfx = randomBytes(6).toString('hex')
    const [p] = await db.insert(projects).values({
      organizationId: `ur-org-${sfx}`,
      slug: `ur-${sfx}`,
      name: 'Unresolvable',
      connectCode: `ur-cc-${sfx}`,
      knowledgeConfig: { redactionRules: [{ kind: 'detector', id: 'detector-that-does-not-exist', v: 1 }] },
    }).returning({ id: projects.id })
    const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
    const t = await closedThread(p!.id, a!.id, 'a perfectly ordinary lesson')

    await markProjectKnowledgeDirty(db, p!.id)
    const refused = await runExtractorSweep(db, { projectId: p!.id })
    expect(refused.candidates).toBe(0)

    // No claim: this is the difference between a deferral and a permanent loss.
    const [claim] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from thread_extraction where project_id = ${p!.id}
    `)
    expect(claim?.n).toBe(0)

    // The owner removes the broken rule. Same thread, now extractable.
    await db.update(projects).set({ knowledgeConfig: { redactionRules: [] } }).where(eq(projects.id, p!.id))
    await markProjectKnowledgeDirty(db, p!.id)
    const ok = await runExtractorSweep(db, { projectId: p!.id })
    expect(ok.candidates).toBe(1)
    expect(await storedBody(p!.id)).toContain('ordinary lesson')
    const [after] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from thread_extraction where project_id = ${p!.id} and thread_id = ${t}
    `)
    expect(after?.n).toBe(1)
  })
})

/**
 * The gap between the claim and the candidate write, which is where review loop 9 found
 * the previous fix still leaking.
 *
 * "The comparison rides on the claim" was written down as the fix one loop earlier. The
 * claim and the candidate are separate statements and Read Committed gives each its own
 * snapshot, so a settings save landing between them left the claim validated against the
 * old rules and the row that actually holds the text written under them - permanently,
 * since the claim is what the next sweep reads. The guard has to be on the statement
 * that writes the sensitive bytes.
 *
 * Reached deterministically with a trigger on the watermark insert: it fires after the
 * claim and before the candidate, which is exactly the window. The rule change is
 * therefore visible to the candidate insert's own guard, which is the property under
 * test - not the commit ordering of two transactions, which Postgres decides.
 *
 * Mutation-checked: removing the `where exists` from the candidate insert stores the row
 * and leaves the claim, i.e. reproduces the loop 9 finding exactly.
 */
describe('extractor: the guard is on the write that stores the text', () => {
  const TRIGGER3 = `claim_gap_${randomBytes(4).toString('hex')}`

  afterAll(async () => {
    await db.execute(sql.raw(`drop trigger if exists ${TRIGGER3} on thread_extraction`))
    await db.execute(sql.raw(`drop function if exists ${TRIGGER3}_fn()`))
  })

  it('rolls the whole project back when the rules change after the claim', async () => {
    const p = await project([])
    await closedThread(p.id, p.agentId, 'a lesson that must not be stored under old rules')

    await db.execute(sql.raw(`
      create or replace function ${TRIGGER3}_fn() returns trigger as $$
      begin
        if new.project_id = '${p.id}' then
          update project
             set knowledge_config = jsonb_build_object('redactionRules',
                   jsonb_build_array(jsonb_build_object('kind', 'literal', 'value', 'LATE-RULE')))
           where id = '${p.id}';
        end if;
        return new;
      end $$ language plpgsql;
    `))
    await db.execute(sql.raw(`
      create trigger ${TRIGGER3} after insert on thread_extraction
      for each row execute function ${TRIGGER3}_fn()
    `))

    await markProjectKnowledgeDirty(db, p.id)
    const r = await runExtractorSweep(db, { projectId: p.id })
    expect(r.candidates).toBe(0)
    expect(r.projects).toBe(0) // the tick is rolled back, so the project was not processed

    // Nothing stored, and no orphan claim - a watermark with no row behind it would
    // foreclose this thread forever, which is why the remedy here is a rollback rather
    // than skipping the thread.
    expect(await storedBody(p.id)).toBe('')
    const [claim] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from thread_extraction where project_id = ${p.id}
    `)
    expect(claim?.n).toBe(0)

    // And the marker survives the rollback, so the next tick redoes it under the new rule.
    const [marker] = await db.execute<{ dirty: string | null }>(sql`
      select knowledge_dirty_at::text as dirty from project where id = ${p.id}
    `)
    expect(marker?.dirty).not.toBeNull()
  })
})

/**
 * The comparison covers every input the resolver reads, not just the active key.
 *
 * Review loop 11: the first version of the guard compared `redactionRules` alone, while
 * `resolveRedactionRules` also treats a stored legacy `redactionPatterns` key as decisive
 * and fails the write closed. So adding that key concurrently passed the guard while
 * changing the answer - the guard and the resolver disagreed about what "the inputs" are.
 *
 * That is why the snapshot expression is a single exported constant rather than SQL
 * written at each site: two copies are two definitions, and this is the defect class the
 * release keeps finding one layer down.
 */
describe('extractor: the guard covers every input the resolver reads', () => {
  const TRIGGER4 = `legacy_gap_${randomBytes(4).toString('hex')}`

  afterAll(async () => {
    await db.execute(sql.raw(`drop trigger if exists ${TRIGGER4} on thread_extraction`))
    await db.execute(sql.raw(`drop function if exists ${TRIGGER4}_fn()`))
  })

  it('refuses when a legacy key appears after the snapshot, though the rules key is untouched', async () => {
    const p = await project([])
    await closedThread(p.id, p.agentId, 'a lesson written while the rules key never changed')

    // Adds ONLY the legacy key. `redactionRules` stays exactly as snapshotted, so a guard
    // that watches that key alone sees no change and writes the row.
    await db.execute(sql.raw(`
      create or replace function ${TRIGGER4}_fn() returns trigger as $$
      begin
        if new.project_id = '${p.id}' then
          update project
             set knowledge_config = knowledge_config
                   || jsonb_build_object('redactionPatterns', jsonb_build_array('SECRET'))
           where id = '${p.id}';
        end if;
        return new;
      end $$ language plpgsql;
    `))
    await db.execute(sql.raw(`
      create trigger ${TRIGGER4} after insert on thread_extraction
      for each row execute function ${TRIGGER4}_fn()
    `))

    await markProjectKnowledgeDirty(db, p.id)
    const r = await runExtractorSweep(db, { projectId: p.id })
    expect(r.candidates).toBe(0)
    expect(await storedBody(p.id)).toBe('')
    const [claim] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from thread_extraction where project_id = ${p.id}
    `)
    expect(claim?.n).toBe(0)
  })
})
