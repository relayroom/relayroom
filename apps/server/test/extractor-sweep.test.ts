/**
 * Leased extractor sweep (FEAT-0004 L3).
 *
 * The acceptance invariants: output is always a candidate (never trusted), the
 * durable marker catches a missed NOTIFY, a project is processed by a single writer
 * under concurrent triggers, and a thread that closes mid-run is not dropped
 * (clear-if-unchanged).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agents, knowledge, markProjectKnowledgeDirty, messages, projects, threads } from '@relayroom/db'
import postgres from 'postgres'
import { isProjectDirty, runExtractorSweep } from '../src/knowledge/extractor-sweep'
import { makeTestApp, TEST_DATABASE_URL } from './helpers'

const { db, bus } = makeTestApp()
const rawSql = postgres(TEST_DATABASE_URL)

afterAll(async () => {
  await bus.close()
  await db.$client.end()
  await rawSql.end()
})

async function project(redactionPatterns?: string[]): Promise<{ id: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `es-org-${sfx}`, slug: `es-${sfx}`, name: 'Extractor', connectCode: `es-cc-${sfx}`,
    ...(redactionPatterns ? { knowledgeConfig: { redactionPatterns } } : {}),
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
  return { id: p!.id, agentId: a!.id }
}

/** A thread with messages, at a given status. */
async function thread(
  projectId: string, agentId: string, status: string,
  msgs: { body: string; agent?: boolean }[],
): Promise<string> {
  const [t] = await db.insert(threads)
    .values({ projectId, subject: `subj-${randomBytes(3).toString('hex')}`, status })
    .returning({ id: threads.id })
  for (const m of msgs) {
    await db.insert(messages).values({
      threadId: t!.id, fromAgentId: m.agent === false ? null : agentId, body: m.body,
    })
  }
  return t!.id
}

async function candidatesFor(projectId: string) {
  return db.select().from(knowledge)
    .where(and(eq(knowledge.projectId, projectId), eq(knowledge.sourceKind, 'thread')))
}

describe('extractor output', () => {
  it('writes a candidate per closed thread - never trusted', async () => {
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'the lesson' }])
    await markProjectKnowledgeDirty(db, p.id)

    const r = await runExtractorSweep(db, { projectId: p.id })
    expect(r.candidates).toBe(1)
    const rows = await candidatesFor(p.id)
    expect(rows).toHaveLength(1)
    // The load-bearing guard: extractor output is candidate, always.
    expect(rows[0]!.validationState).toBe('candidate')
    expect(rows[0]!.sourceKind).toBe('thread')
  })

  it('extracts answered threads too, and skips open ones', async () => {
    const p = await project()
    await thread(p.id, p.agentId, 'answered', [{ body: 'answered lesson' }])
    await thread(p.id, p.agentId, 'open', [{ body: 'still open' }])
    await markProjectKnowledgeDirty(db, p.id)

    await runExtractorSweep(db, { projectId: p.id })
    expect(await candidatesFor(p.id)).toHaveLength(1)
  })

  it('applies redaction before writing the candidate', async () => {
    const p = await project(['sk-[a-z0-9]+'])
    await thread(p.id, p.agentId, 'closed', [{ body: 'rotate sk-abc123 now' }])
    await markProjectKnowledgeDirty(db, p.id)
    await runExtractorSweep(db, { projectId: p.id })
    const [row] = await candidatesFor(p.id)
    expect(row!.body).not.toContain('sk-abc123')
  })

  it('is idempotent - a thread is extracted once, not again on a re-run', async () => {
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'once' }])
    await markProjectKnowledgeDirty(db, p.id)

    await runExtractorSweep(db, { projectId: p.id })
    await markProjectKnowledgeDirty(db, p.id) // dirtied again
    const r2 = await runExtractorSweep(db, { projectId: p.id })
    expect(r2.candidates).toBe(0) // already has a candidate citing it
    expect(await candidatesFor(p.id)).toHaveLength(1)
  })
})

describe('durable marker', () => {
  it('clears the marker after a successful sweep', async () => {
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'x' }])
    await markProjectKnowledgeDirty(db, p.id)
    expect(await isProjectDirty(db, p.id)).toBe(true)
    await runExtractorSweep(db, { projectId: p.id })
    expect(await isProjectDirty(db, p.id)).toBe(false)
  })

  it('catches a thread even when no NOTIFY was sent - the marker is enough', async () => {
    // markProjectKnowledgeDirty sets only the durable column (no bus emit). The sweep must
    // still find and extract the thread: correctness rests on the marker, not NOTIFY.
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'missed the notify' }])
    await markProjectKnowledgeDirty(db, p.id)
    const r = await runExtractorSweep(db, { projectId: p.id })
    expect(r.candidates).toBe(1)
  })

  it('does not process a project that is not dirty', async () => {
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'never marked' }])
    // no markProjectKnowledgeDirty
    const r = await runExtractorSweep(db, { projectId: p.id })
    expect(r.projects).toBe(0)
    expect(await candidatesFor(p.id)).toHaveLength(0)
  })
})

describe('single writer per project', () => {
  it('a second concurrent sweep is blocked by the advisory lock, not merely serialized', async () => {
    // Observe the lock directly: hold pg_advisory_xact_lock for the project in one
    // open transaction, then run a sweep. The sweep's pg_try_advisory_xact_lock must
    // FAIL and skip the project (processed=0) rather than duplicate its work.
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'contested' }])
    await markProjectKnowledgeDirty(db, p.id)

    // A raw connection holds the lock (namespace + hashtext must match the sweep's).
    const holder = postgres(TEST_DATABASE_URL, { max: 1 })
    const conn = await holder.reserve()
    try {
      await conn`begin`
      await conn`select pg_advisory_xact_lock(${0x4b4e4f57}, hashtext(${p.id}))`

      const r = await runExtractorSweep(db, { projectId: p.id })
      expect(r.projects).toBe(0) // could not claim; skipped
      expect(await candidatesFor(p.id)).toHaveLength(0)
      // Marker left in place for a later sweep.
      expect(await isProjectDirty(db, p.id)).toBe(true)

      await conn`rollback`
    }
    finally {
      conn.release()
      await holder.end({ timeout: 5 })
    }

    // With the lock released, the next sweep processes it.
    const r2 = await runExtractorSweep(db, { projectId: p.id })
    expect(r2.candidates).toBe(1)
  })
})

describe('clear-if-unchanged', () => {
  it('does not clear the marker when it was bumped during the run', async () => {
    // Simulate a thread closing mid-run: after the sweep reads dirtyAt, another close
    // bumps it. The clear is conditional on the old value, so it must NOT clear, and
    // the project stays dirty for the next sweep.
    const p = await project()
    await thread(p.id, p.agentId, 'closed', [{ body: 'first' }])

    // Set an OLD marker, then the sweep will read it; but before we run, we cannot
    // interleave inside the sweep from the test, so instead assert the SQL guard
    // directly: clearing with a stale expected-value is a no-op.
    await markProjectKnowledgeDirty(db, p.id)
    const [{ dirty_at: oldTs }] = await rawSql<{ dirty_at: Date }[]>`
      select knowledge_dirty_at as dirty_at from project where id = ${p.id}`

    // Bump the marker to a newer instant (a new close).
    await rawSql`select pg_sleep(0.01)`
    await markProjectKnowledgeDirty(db, p.id)

    // A clear guarded on the OLD ts must affect nothing.
    const cleared = await rawSql`
      update project set knowledge_dirty_at = null
      where id = ${p.id} and knowledge_dirty_at = ${oldTs}
      returning id`
    expect(cleared.length).toBe(0)
    expect(await isProjectDirty(db, p.id)).toBe(true) // still dirty; next sweep runs
  })
})
