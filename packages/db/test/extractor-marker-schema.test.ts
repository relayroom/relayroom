import { eq, isNotNull, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject } from '../src/bootstrap'
import { markProjectKnowledgeDirty } from '../src/knowledge'
import { projects } from '../src/schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/**
 * The extractor's trigger is a single durable column, and its correctness lives
 * entirely in how it is cleared: the sweep must clear it ONLY when it still holds
 * the value it snapshotted, or a thread that closed mid-run has its mark erased and
 * never gets extracted. These exercise that clear-if-unchanged dance at the SQL
 * level, since that is where the guarantee actually is.
 */
describe('extractor marker (project.knowledge_dirty_at)', () => {
  const dirtyAt = async (id: string) => {
    const [row] = await db.select({ v: projects.knowledgeDirtyAt }).from(projects).where(eq(projects.id, id))
    return row!.v
  }
  /**
   * The marker snapshotted at full precision, as text. A JS Date only keeps
   * milliseconds, but Postgres stores microseconds, so a snapshot round-tripped
   * through a Date would fail to equal the stored value and the clear would MISS -
   * leaving the project stuck dirty forever. The snapshot must carry the exact
   * stored value; text is the faithful way to hold it.
   */
  const snapshotText = async (id: string) => {
    const [row] = await db.execute<{ ts: string | null }>(
      sql`select knowledge_dirty_at::text as ts from ${projects} where id = ${id}`,
    )
    return row!.ts
  }
  const clearIfUnchanged = (id: string, snap: string) =>
    db.execute(sql`
      update ${projects} set knowledge_dirty_at = null
       where id = ${id} and knowledge_dirty_at = ${snap}::timestamptz
      returning id
    `)

  it('starts null and takes a timestamp when a thread closes', async () => {
    const project = await getOrCreateProject(db, 'ext-mark')
    expect(await dirtyAt(project.id)).toBeNull()
    await db.update(projects).set({ knowledgeDirtyAt: sql`now()` }).where(eq(projects.id, project.id))
    expect(await dirtyAt(project.id)).not.toBeNull()
  })

  it('markProjectKnowledgeDirty is the single setter both packages call', async () => {
    // Server (close tool, autoclose) and web (status change) all route through this
    // one function, so a thread resolved from either side is always swept. It only
    // writes now() and never reads the marker, so the clear-side precision trap
    // does not apply here.
    const project = await getOrCreateProject(db, 'ext-setter')
    expect(await dirtyAt(project.id)).toBeNull()
    await markProjectKnowledgeDirty(db, project.id)
    expect(await dirtyAt(project.id)).not.toBeNull()

    // Safe under repeated closes: a second call re-stamps now() and never clears,
    // so a marked-but-not-yet-swept project stays dirty. (It re-stamps rather than
    // no-ops, but only the clearing side cares about the exact value, and it snaps
    // its own.)
    await markProjectKnowledgeDirty(db, project.id)
    expect(await dirtyAt(project.id)).not.toBeNull()
  })

  it('marks only the named project', async () => {
    const target = await getOrCreateProject(db, 'ext-setter-target')
    const bystander = await getOrCreateProject(db, 'ext-setter-bystander')
    await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, bystander.id))
    await markProjectKnowledgeDirty(db, target.id)
    expect(await dirtyAt(target.id)).not.toBeNull()
    expect(await dirtyAt(bystander.id)).toBeNull()
  })

  it('clears only when the marker still equals the snapshot', async () => {
    // The sweep snapshots the value, does its work, then clears keyed on that
    // snapshot. In the quiet case the value has not moved and the clear takes.
    const project = await getOrCreateProject(db, 'ext-clear')
    await db.update(projects).set({ knowledgeDirtyAt: sql`now()` }).where(eq(projects.id, project.id))
    const snapshot = await snapshotText(project.id)

    const cleared = await clearIfUnchanged(project.id, snapshot!)
    expect(cleared).toHaveLength(1)
    expect(await dirtyAt(project.id)).toBeNull()
  })

  it('does not clobber a re-dirty that happened mid-run', async () => {
    // A thread closes again while the sweep is working: the marker moves to a new
    // timestamp. The clear, still keyed on the OLD snapshot, must miss - otherwise
    // that second close is silently dropped and never extracted.
    const project = await getOrCreateProject(db, 'ext-redirty')
    await db.update(projects).set({ knowledgeDirtyAt: sql`now()` }).where(eq(projects.id, project.id))
    const snapshot = await snapshotText(project.id)

    // re-dirty to a strictly later value while the "sweep" is notionally running
    await db.update(projects)
      .set({ knowledgeDirtyAt: sql`now() + interval '1 second'` })
      .where(eq(projects.id, project.id))

    const cleared = await clearIfUnchanged(project.id, snapshot!)
    expect(cleared).toHaveLength(0)         // the stale clear misses
    expect(await dirtyAt(project.id)).not.toBeNull() // the re-dirty survives for the next sweep
  })

  it('round-trips a redaction denylist through knowledge_config', async () => {
    // The field the extractor/learn redaction reads. It is jsonb, so this is a
    // type-only addition - the migration adds no column for it - and regex
    // metacharacters must survive the round trip intact.
    const project = await getOrCreateProject(db, 'ext-denylist')
    const patterns = ['sk-[A-Za-z0-9]{20,}', '\\d{3}-\\d{2}-\\d{4}']
    await db.update(projects)
      .set({ knowledgeConfig: { retentionDays: 14, redactionPatterns: patterns } })
      .where(eq(projects.id, project.id))
    const [row] = await db.select({ c: projects.knowledgeConfig }).from(projects).where(eq(projects.id, project.id))
    expect(row!.c.redactionPatterns).toEqual(patterns)
    expect(row!.c.retentionDays).toBe(14)
  })

  it('lets a sweep claim exactly the dirty projects', async () => {
    // The claim predicate is `knowledge_dirty_at IS NOT NULL`. A freshly marked
    // project appears in it; a clean one does not.
    const dirty = await getOrCreateProject(db, 'ext-claim-dirty')
    const clean = await getOrCreateProject(db, 'ext-claim-clean')
    await db.update(projects).set({ knowledgeDirtyAt: null }).where(eq(projects.id, clean.id))
    await db.update(projects).set({ knowledgeDirtyAt: sql`now()` }).where(eq(projects.id, dirty.id))

    const claimed = await db.select({ id: projects.id }).from(projects)
      .where(isNotNull(projects.knowledgeDirtyAt))
    const ids = new Set(claimed.map(r => r.id))
    expect(ids.has(dirty.id)).toBe(true)
    expect(ids.has(clean.id)).toBe(false)
  })
})
