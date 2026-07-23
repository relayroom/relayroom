import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { getOrCreateProject } from '../src/bootstrap'
import { knowledge, knowledgeAudits, knowledgeValidations, recallLogs } from '../src/schema'

import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/**
 * These assert the guarantees the knowledge tables are supposed to provide at the
 * database level, rather than in whichever code path happens to write them. Every
 * one of them is a rule the promotion ledger depends on: if the database stops
 * enforcing it, a claim can become trusted on evidence that should not have counted.
 */
/** The driver wraps the server error, so the constraint name lives on the cause. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    const parts = [String((err as Error).message)]
    for (let c = (err as { cause?: unknown }).cause; c; c = (c as { cause?: unknown }).cause) {
      parts.push(String((c as Error).message))
    }
    return parts.join(" | ")
  }
  throw new Error("expected the insert to be rejected")
}

describe('knowledge schema', () => {
  const seed = async (slug: string) => {
    const project = await getOrCreateProject(db, slug)
    const [row] = await db.insert(knowledge).values({
      projectId: project.id,
      kind: 'fact',
      title: 'migration smoke',
      body: 'the migration runner applies 0015 on boot',
      sourceKind: 'human',
    }).returning()
    return { project, entry: row }
  }

  it('starts every entry as a candidate, unpromoted', async () => {
    // learn must never be able to write something that is already trusted.
    const { entry } = await seed('kn-defaults')
    expect(entry.validationState).toBe('candidate')
    expect(entry.promotedAt).toBeNull()
    expect(entry.confidence).toBe(0)
  })

  it('refuses a kind or a state outside the documented domain', async () => {
    const { project } = await seed('kn-domain')
    expect(await rejection(() => db.insert(knowledge).values({
      projectId: project.id, kind: 'nonsense', title: 't', body: 'b', sourceKind: 'human',
    }))).toContain('knowledge_kind_ck')
    expect(await rejection(() => db.insert(knowledge).values({
      projectId: project.id, kind: 'fact', title: 't', body: 'b', sourceKind: 'human',
      validationState: 'maybe',
    }))).toContain('knowledge_state_ck')
  })

  it('counts one issuer-source once, so a repeated signal cannot manufacture agreement', async () => {
    const { entry } = await seed('kn-dedup')
    const validation = {
      knowledgeId: entry.id,
      signal: 'support',
      issuer: 'human',
      issuerId: 'user-1',
      sourceFingerprint: 'fp-1',
    }
    await db.insert(knowledgeValidations).values(validation)
    // The same CI job re-run, or a double-clicked confirm: recorded once.
    await db.insert(knowledgeValidations).values(validation).onConflictDoNothing()
    const rows = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.counted).toBe(true) // only an unmapped attestation is stored uncounted
  })

  it('allows the opposite signal from the same source', async () => {
    // Dedup is per (knowledge, signal, source): the same issuer may later contradict
    // what it once supported, and that has to be recordable.
    const { entry } = await seed('kn-dedup-signal')
    const base = { knowledgeId: entry.id, issuer: 'human', issuerId: 'user-1', sourceFingerprint: 'fp-1' }
    await db.insert(knowledgeValidations).values({ ...base, signal: 'support' })
    await db.insert(knowledgeValidations).values({ ...base, signal: 'contradict' })
    const rows = await db.select().from(knowledgeValidations)
      .where(eq(knowledgeValidations.knowledgeId, entry.id))
    expect(rows).toHaveLength(2)
  })

  it('keeps the audit trail when the entry it describes is deleted', async () => {
    // The audit is history: losing it with the row would defeat the point.
    const { project, entry } = await seed('kn-audit')
    await db.insert(knowledgeAudits).values({
      projectId: project.id,
      action: 'promote',
      knowledgeId: entry.id,
      fromState: 'candidate',
      toState: 'trusted',
      actorKind: 'human',
    })
    await db.delete(knowledge).where(eq(knowledge.id, entry.id))
    const rows = await db.select().from(knowledgeAudits)
      .where(eq(knowledgeAudits.projectId, project.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.knowledgeId).toBeNull() // set null, not cascaded
    expect(rows[0]!.fromState).toBe('candidate')
  })

  it('nulls a recall reference rather than deleting the log row', async () => {
    const { project, entry } = await seed('kn-recall')
    await db.insert(recallLogs).values({ projectId: project.id, usedKnowledgeId: entry.id })
    await db.delete(knowledge).where(eq(knowledge.id, entry.id))
    const rows = await db.select().from(recallLogs).where(eq(recallLogs.projectId, project.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.usedKnowledgeId).toBeNull()
  })

  it('answers a similarity query through the trigram index', async () => {
    // recall matches a natural-language query against title+body with the `%`
    // operator; without pg_trgm and the GIN index this errors rather than degrades.
    const { project } = await seed('kn-trgm')
    const hits = await db.execute(sql`
      select id from ${knowledge}
       where project_id = ${project.id}
         and (title || ' ' || body) % ${'migration runner'}
    `)
    expect(hits.length).toBe(1)
  })

  it('can back a composite foreign key on (project_id, id)', async () => {
    // L1's check map points at a knowledge row with BOTH ids, so a project cannot
    // attest another project's claim. That needs the unique index to exist now.
    const { project, entry } = await seed('kn-tenant')
    // Not a temporary table: Postgres refuses an FK from a temp table to a permanent
    // one, and it is the permanent side of that reference we are proving works.
    await db.execute(sql`
      create table tenant_fk_probe (
        project_id uuid not null,
        knowledge_id uuid not null,
        foreign key (project_id, knowledge_id) references knowledge(project_id, id) on delete cascade
      )
    `)
    try {
      await db.execute(sql`insert into tenant_fk_probe values (${project.id}, ${entry.id})`)
      const crossProject = await rejection(() => db.execute(sql`
        insert into tenant_fk_probe
        values ('00000000-0000-0000-0000-000000000000'::uuid, ${entry.id})
      `))
      expect(crossProject).toContain('foreign key')
    } finally {
      await db.execute(sql`drop table tenant_fk_probe`)
    }
  })
})
