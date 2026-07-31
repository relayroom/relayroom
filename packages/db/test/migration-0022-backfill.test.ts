/**
 * Migration 0022's backfill, run against its own SQL.
 *
 * WHY THIS EXISTS NOW. The backfill is what protects data that predates the watermark
 * table: every candidate written before 0022 recorded its thread only in
 * `knowledge.source_refs`, so without it the resurrection fix would have covered only
 * threads extracted after the migration - close to worthless for a P0 filed over
 * existing data. A server test claimed to cover this and did not: it deleted the
 * watermark and asserted suppression, which the (now removed) `source_refs` predicate
 * was doing, and deleting the watermark is the inverse of the state the backfill
 * produces.
 *
 * And the backfill is now load-bearing for a second reason. It deliberately excludes
 * `learn` rows - *"backfilling them would make an incidental suppression permanent"* -
 * and that exclusion is one of the two places the release relied on when it removed the
 * predicate and let a `learn` row stop suppressing extraction. A decision that an
 * argument rests on should be checkable, not quoted.
 *
 * The statement is READ FROM THE MIGRATION FILE rather than copied here. A copy would
 * pass while the shipped SQL rotted, which is the exact failure mode this whole area
 * keeps producing: a claim about code that is not a check of it. Re-running is safe -
 * the statement ends in ON CONFLICT DO NOTHING.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { knowledge, projects, threadExtractions, threads } from '../src/schema'
import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/** The last statement of 0022 - the backfill - taken from the file that ships. */
function backfillStatement(): string {
  const path = fileURLToPath(new URL('../drizzle/0022_add_thread_extraction_watermark.sql', import.meta.url))
  const statements = readFileSync(path, 'utf8').split('--> statement-breakpoint')
  const last = statements[statements.length - 1]!.trim()
  // Fail loudly rather than silently backfilling nothing if the file is ever reordered:
  // a no-op statement would make every assertion below pass for the wrong reason.
  if (!/insert\s+into\s+thread_extraction/i.test(last)) {
    throw new Error('0022 no longer ends with the backfill insert; this test is aimed at the wrong statement')
  }
  return last
}

async function project(): Promise<string> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `bf-org-${sfx}`, slug: `bf-${sfx}`, name: 'Backfill', connectCode: `bf-cc-${sfx}`,
  }).returning({ id: projects.id })
  return p!.id
}

async function thread(projectId: string): Promise<string> {
  const [t] = await db.insert(threads)
    .values({ projectId, subject: `subj-${randomBytes(3).toString('hex')}`, status: 'closed' })
    .returning({ id: threads.id })
  return t!.id
}

async function watermarked(projectId: string, threadId: string): Promise<string | null> {
  const [row] = await db.select({ reason: threadExtractions.reason }).from(threadExtractions)
    .where(and(eq(threadExtractions.projectId, projectId), eq(threadExtractions.threadId, threadId)))
  return row?.reason ?? null
}

describe('migration 0022 backfill', () => {
  it('covers extractor rows and leaves learn rows alone', async () => {
    const p = await project()
    const extracted = await thread(p)
    const learned = await thread(p)

    await db.insert(knowledge).values([
      {
        projectId: p, kind: 'fact', title: 'from the extractor', body: 'a candidate the sweep wrote',
        sourceKind: 'thread', sourceRefs: [{ threadId: extracted }], validationState: 'candidate',
      },
      {
        projectId: p, kind: 'pitfall', title: 'from an agent', body: 'a lesson an agent typed',
        sourceKind: 'learn', sourceRefs: [{ threadId: learned }], validationState: 'candidate',
      },
    ])

    await db.execute(sql.raw(backfillStatement()))

    expect(await watermarked(p, extracted)).toBe('extracted')
    // THE EXCLUSION, asserted rather than quoted. A `learn` row carries an identical
    // {threadId}, and backfilling it would have made an incidental suppression
    // permanent - the decision the 0.6.0 sweep change rests on.
    expect(await watermarked(p, learned)).toBeNull()
  })

  it('survives the shapes that would abort it, and still covers the good row beside them', async () => {
    // Each of these aborts the whole statement if its guard is missing - and an aborted
    // migration is not a partial backfill, it is no backfill for anybody. The good row
    // in the same project is what says the statement still did its work rather than
    // failing quietly.
    const p = await project()
    const good = await thread(p)
    const other = await project()
    const foreign = await thread(other)

    await db.insert(knowledge).values([
      {
        projectId: p, kind: 'fact', title: 'good', body: 'b',
        sourceKind: 'thread', sourceRefs: [{ threadId: good }], validationState: 'candidate',
      },
      {
        // Not an array. The column is plain jsonb with no CHECK, so this would make
        // jsonb_array_elements abort the set.
        projectId: p, kind: 'fact', title: 'non-array refs', body: 'b',
        sourceKind: 'thread', sourceRefs: { threadId: good } as never, validationState: 'candidate',
      },
      {
        // Not a uuid. Would abort the cast.
        projectId: p, kind: 'fact', title: 'malformed id', body: 'b',
        sourceKind: 'thread', sourceRefs: [{ threadId: 'not-a-uuid' }] as never, validationState: 'candidate',
      },
      {
        // A ref with no threadId at all.
        projectId: p, kind: 'fact', title: 'no threadId', body: 'b',
        sourceKind: 'thread', sourceRefs: [{ eventId: 'x' }] as never, validationState: 'candidate',
      },
      {
        // A real thread, but in another project: satisfies one FK and not the pair.
        // Backfilling it would write a row that belongs to neither.
        projectId: p, kind: 'fact', title: 'cross-project', body: 'b',
        sourceKind: 'thread', sourceRefs: [{ threadId: foreign }] as never, validationState: 'candidate',
      },
    ])

    await expect(db.execute(sql.raw(backfillStatement()))).resolves.toBeDefined()

    expect(await watermarked(p, good)).toBe('extracted')
    expect(await watermarked(p, foreign)).toBeNull()
    expect(await watermarked(other, foreign)).toBeNull()
  })
})
