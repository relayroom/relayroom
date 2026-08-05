/**
 * Migration 0023, run against its own SQL.
 *
 * WHY THIS IS TESTED AND NOT JUST REVIEWED. The migration deletes rows, and its predicate
 * is a RECONSTRUCTION rather than a flag: `source_kind = 'thread'` cannot separate the
 * automatic extractor's output from the lessons agents wrote through `close`, because
 * until 0.7.0 both wrote that value with identical columns. So the migration rebuilds
 * what the extractor would have produced - the thread's subject as the title, its last
 * agent message trimmed to 2000 characters as the body, kind 'decision' - and deletes
 * only exact matches.
 *
 * A reconstruction can be wrong in two directions and only one of them is recoverable.
 * Leaving a junk row is visible and purgeable; deleting an agent's lesson is not. Every
 * case below therefore pins which side of that line a given shape falls on, and the
 * uncertain shapes (thread deleted, body redacted since) are asserted to be LEFT ALONE
 * rather than guessed at.
 *
 * The SQL is read from the migration file, not copied here: a copy passes while the
 * shipped statement rots, which is the same reason 0022's test reads its file.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/client'
import { agents, knowledge, messages, projects, threadExtractions, threads } from '../src/schema'
import { TEST_DATABASE_URL } from '../../../test/db-url'

const db = createDb(TEST_DATABASE_URL)
afterAll(() => db.$client.end())

/** The migration's statements, in order, from the file that ships. */
function statements(): string[] {
  const path = fileURLToPath(new URL('../drizzle/0023_retire_auto_extracted_knowledge.sql', import.meta.url))
  const parts = readFileSync(path, 'utf8').split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)
  // Fail loudly rather than silently running nothing: a no-op would make every assertion
  // below pass for the wrong reason.
  if (!parts.some(p => /delete\s+from\s+knowledge/i.test(p))) {
    throw new Error('0023 no longer deletes from knowledge; this test is aimed at the wrong file')
  }
  if (!parts.some(p => /update\s+knowledge/i.test(p))) {
    throw new Error('0023 no longer relabels; this test is aimed at the wrong file')
  }
  return parts
}

async function runMigration() {
  // One transaction, like the migrator: the temp table is created and dropped inside it.
  await db.transaction(async (tx) => {
    for (const stmt of statements()) await tx.execute(sql.raw(stmt))
  })
}

async function project(): Promise<{ projectId: string; agentId: string }> {
  const sfx = randomBytes(6).toString('hex')
  const [p] = await db.insert(projects).values({
    organizationId: `rx-org-${sfx}`, slug: `rx-${sfx}`, name: 'Retire', connectCode: `rx-cc-${sfx}`,
  }).returning({ id: projects.id })
  const [a] = await db.insert(agents).values({ projectId: p!.id, part: 'w' }).returning({ id: agents.id })
  return { projectId: p!.id, agentId: a!.id }
}

/** A closed thread whose last agent message is `body`. */
async function thread(projectId: string, agentId: string, subject: string, body: string): Promise<string> {
  const [t] = await db.insert(threads)
    .values({ projectId, subject, status: 'closed' })
    .returning({ id: threads.id })
  // An earlier message and a system row, so "the LAST message with an agent author" is a
  // real choice rather than the only row present.
  await db.insert(messages).values({ threadId: t!.id, fromAgentId: agentId, body: 'an earlier turn' })
  await db.insert(messages).values({ threadId: t!.id, fromAgentId: agentId, body })
  await db.insert(messages).values({ threadId: t!.id, fromAgentId: null, body: 'a system note' })
  return t!.id
}

async function knowledgeRow(projectId: string, threadId: string, over: {
  title: string
  body: string
  kind?: string
  sourceKind?: string
  validationState?: string
  promotedAt?: Date
}): Promise<string> {
  const [row] = await db.insert(knowledge).values({
    projectId,
    kind: over.kind ?? 'decision',
    title: over.title,
    body: over.body,
    sourceKind: over.sourceKind ?? 'thread',
    sourceRefs: [{ threadId }],
    validationState: over.validationState ?? 'candidate',
    ...(over.promotedAt ? { promotedAt: over.promotedAt } : {}),
  }).returning({ id: knowledge.id })
  return row!.id
}

const exists = async (id: string) =>
  (await db.select({ id: knowledge.id }).from(knowledge).where(eq(knowledge.id, id))).length > 0
const sourceKindOf = async (id: string) =>
  (await db.select({ k: knowledge.sourceKind }).from(knowledge).where(eq(knowledge.id, id)))[0]?.k
const watermarkOf = async (projectId: string, threadId: string) =>
  (await db.select({ r: threadExtractions.reason }).from(threadExtractions)
    .where(and(eq(threadExtractions.projectId, projectId), eq(threadExtractions.threadId, threadId))))[0]?.r

describe('migration 0023: retire auto-extracted knowledge', () => {
  it('deletes a row that is byte-for-byte what the extractor produced, and its watermark', async () => {
    const { projectId, agentId } = await project()
    const subject = `how to roll back ${randomBytes(3).toString('hex')}`
    const last = 'run the down script first, then redeploy'
    const t = await thread(projectId, agentId, subject, last)
    const id = await knowledgeRow(projectId, t, { title: subject, body: last })
    await db.insert(threadExtractions).values({ projectId, threadId: t, reason: 'extracted' })

    await runMigration()

    expect(await exists(id)).toBe(false)
    // The watermark goes too. Left behind it would refuse the close-lesson that replaces
    // what was just deleted - the thread would be unable to receive a lesson forever.
    expect(await watermarkOf(projectId, t)).toBeUndefined()
  })

  it('relabels an agent-written lesson instead of deleting it', async () => {
    // The row this migration exists to protect. On the production hub there was exactly
    // one, and it is the reason the predicate is not `source_kind = 'thread'`.
    const { projectId, agentId } = await project()
    const subject = `review queue backlog ${randomBytes(3).toString('hex')}`
    const t = await thread(projectId, agentId, subject, 'the last message of the conversation')
    const id = await knowledgeRow(projectId, t, {
      title: 'do not read attachment_text > 0 as evidence',
      body: 'five percent of them are accessibility certificates',
      kind: 'pitfall',
    })
    await db.insert(threadExtractions).values({ projectId, threadId: t, reason: 'extracted' })

    await runMigration()

    expect(await exists(id)).toBe(true)
    expect(await sourceKindOf(id)).toBe('lesson')
    // Its claim stays: the thread's knowledge really is decided, by the agent.
    expect(await watermarkOf(projectId, t)).toBe('extracted')
  })

  it('leaves a promoted row alone even when it matches the extractor exactly', async () => {
    // Empty on the hub measured before this shipped - nobody had promoted one - and kept
    // because a deployment where a human looked at one of these and promoted it is a
    // deployment where a person's judgement is later and more specific than ours.
    const { projectId, agentId } = await project()
    const subject = `a promoted extraction ${randomBytes(3).toString('hex')}`
    const last = 'the message that became the body'
    const t = await thread(projectId, agentId, subject, last)
    const id = await knowledgeRow(projectId, t, {
      title: subject, body: last, validationState: 'trusted', promotedAt: new Date(),
    })

    await runMigration()

    expect(await exists(id)).toBe(true)
    expect(await sourceKindOf(id)).toBe('thread')
  })

  it('leaves a row whose body no longer matches, rather than deleting on a partial match', async () => {
    // What a project with redaction rules looks like: the title still equals the subject,
    // but the stored body had spans removed at extraction time and no longer equals the
    // message. Unattributable - so it keeps `thread` and stays. Junk that survives is
    // visible and purgeable; a lesson that does not survive is neither.
    const { projectId, agentId } = await project()
    const subject = `a redacted extraction ${randomBytes(3).toString('hex')}`
    const t = await thread(projectId, agentId, subject, 'deploy with sk-secret-token before rebasing')
    const id = await knowledgeRow(projectId, t, { title: subject, body: 'deploy with  before rebasing' })

    await runMigration()

    expect(await exists(id)).toBe(true)
    expect(await sourceKindOf(id)).toBe('thread')
  })

  it('leaves a row whose thread is gone, in either direction', async () => {
    // No thread, no reconstruction, no attribution. Not deleted (it might be a lesson)
    // and not relabelled (it might be extractor output).
    const { projectId, agentId } = await project()
    const t = await thread(projectId, agentId, 'a thread that will be deleted', 'its last message')
    const id = await knowledgeRow(projectId, t, { title: 'a thread that will be deleted', body: 'its last message' })
    await db.delete(threads).where(eq(threads.id, t))

    await runMigration()

    expect(await exists(id)).toBe(true)
    expect(await sourceKindOf(id)).toBe('thread')
  })

  it('does not touch learn rows, proposer rows, or a purged watermark', async () => {
    const { projectId, agentId } = await project()
    const subject = `an untouched thread ${randomBytes(3).toString('hex')}`
    const t = await thread(projectId, agentId, subject, 'the last message')
    const learn = await knowledgeRow(projectId, t, { title: subject, body: 'the last message', sourceKind: 'learn' })
    const proposer = await knowledgeRow(projectId, t, { title: subject, body: 'the last message', sourceKind: 'proposer' })
    // A DELETABLE row on the same thread, so the watermark clause is actually exercised:
    // without it this case would pass whether or not the migration filtered on
    // reason = 'extracted', because nothing would have been queued for deletion at all.
    const junk = await knowledgeRow(projectId, t, { title: subject, body: 'the last message' })
    await db.insert(threadExtractions).values({ projectId, threadId: t, reason: 'purged' })

    await runMigration()

    expect(await exists(learn)).toBe(true)
    expect(await sourceKindOf(learn)).toBe('learn')
    expect(await exists(proposer)).toBe(true)
    expect(await exists(junk)).toBe(false)
    // A purge is an operator's decision and is not ours to undo, even on a thread whose
    // extracted row we just removed.
    expect(await watermarkOf(projectId, t)).toBe('purged')
  })

  it('is idempotent - running it twice changes nothing the second time', async () => {
    // Migrations run once, but a hand re-run during an incident is exactly when this
    // matters, and a relabelled row must not then be mistaken for anything else.
    const { projectId, agentId } = await project()
    const subject = `idempotence ${randomBytes(3).toString('hex')}`
    const last = 'the body that matches'
    const t = await thread(projectId, agentId, subject, last)
    const junk = await knowledgeRow(projectId, t, { title: subject, body: last })
    const t2 = await thread(projectId, agentId, `${subject} two`, 'another last message')
    const lesson = await knowledgeRow(projectId, t2, { title: 'an agent wrote this', body: 'and this', kind: 'pitfall' })

    await runMigration()
    await runMigration()

    expect(await exists(junk)).toBe(false)
    expect(await exists(lesson)).toBe(true)
    expect(await sourceKindOf(lesson)).toBe('lesson')
  })
})
