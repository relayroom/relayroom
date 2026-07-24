/**
 * Leased extractor sweep (FEAT-0004 L3).
 *
 * The automatic intake of the knowledge loop: a closed/answered thread becomes a
 * candidate knowledge entry with no human typing `learn`. The design (02 state
 * machine) mirrors the wake subsystem:
 *
 *   thread -> closed/answered   sets project.knowledge_dirty_at = now()  (+ optional NOTIFY)
 *   this sweep:
 *     claim dirty projects, ONE WRITER PER PROJECT via a pg advisory lock
 *     snapshot ts = knowledge_dirty_at::text (full precision); write candidates
 *     clear: knowledge_dirty_at = NULL WHERE ::text still equals ts  (no clobber if re-dirtied mid-run)
 *
 * Correctness rests on the DURABLE MARKER, not the NOTIFY. A missed NOTIFY is caught
 * on the next sweep because the marker persists; the NOTIFY is only latency. That is
 * why the sweep exists at all and why it is tested against a marker set with no
 * notify.
 *
 * SINGLE WRITER PER PROJECT is the core invariant. Two workers processing one
 * project would race to create the same candidates. `pg_try_advisory_xact_lock`
 * gives it: the second worker's try fails and it skips the project this tick rather
 * than duplicating work. The lock auto-releases at transaction end - the reason 05
 * specifies an advisory lock over the wake-lease row, which is built for wake_intent.
 *
 * WHICH THREADS a dirty project's sweep processes: the marker is project-level, and
 * the only per-thread record of "already extracted" is a candidate whose sourceRefs
 * cite the thread. So the sweep extracts closed/answered threads that have NO such
 * candidate yet - each thread once, idempotent, bounded by un-extracted threads. Re-
 * extraction when a closed thread later changes, and a per-thread watermark, are
 * deferred with the intelligent extractor; a closed thread rarely gains messages, so
 * once-per-thread is the honest L3 behaviour, not a gap.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { knowledge, messages, projects, threads } from '@relayroom/db'
import { extractCandidateFromThread } from './extract'

/** Advisory-lock namespace for the extractor, so its keys cannot collide with
 *  another subsystem's advisory locks on the same hashed project id. */
const EXTRACTOR_LOCK_NAMESPACE = 0x4b4e4f57 // 'KNOW'

/** Max dirty projects handled per tick. */
export const EXTRACTOR_PROJECT_BATCH = 50

/** Thread statuses whose closure feeds the extractor. */
const EXTRACTABLE_STATUSES = ['closed', 'answered'] as const

export interface ExtractorSweepResult {
  /** Projects whose marker was claimed and cleared this tick. */
  projects: number
  /** Candidate rows written across all projects. */
  candidates: number
}

/**
 * Run one extractor sweep tick.
 *
 * `opts.projectId` pins a single project (tests). `opts.now` is injected for tests;
 * production uses the wall clock only to leave production paths clock-free here.
 */
export async function runExtractorSweep(
  db: Db,
  opts: { limit?: number; projectId?: string } = {},
): Promise<ExtractorSweepResult> {
  const limit = opts.limit ?? EXTRACTOR_PROJECT_BATCH

  const dirty = await db
    .select({
      id: projects.id,
      config: projects.knowledgeConfig,
    })
    .from(projects)
    .where(and(
      isNotNull(projects.knowledgeDirtyAt),
      ...(opts.projectId ? [eq(projects.id, opts.projectId)] : []),
    ))
    .orderBy(projects.knowledgeDirtyAt)
    .limit(limit)

  let processed = 0
  let candidates = 0
  for (const project of dirty) {
    const redactionPatterns = project.config?.redactionPatterns ?? []
    const written = await db.transaction(async (tx) => {
      // Single writer: if another worker holds this project, skip it this tick. The
      // lock is transaction-scoped, so it releases when this block ends.
      const [{ locked }] = await tx.execute<{ locked: boolean }>(sql`
        select pg_try_advisory_xact_lock(${EXTRACTOR_LOCK_NAMESPACE}, hashtext(${project.id})) as locked
      `)
      if (!locked) return null // someone else is on it; the marker stays for them

      // Snapshot the marker UNDER THE LOCK, as text. markProjectKnowledgeDirty writes
      // now() at microsecond precision; reading it back through a JS Date truncates to
      // milliseconds, so a Date-valued equality clear below would NEVER match and the
      // marker would never clear. Comparing text to text keeps full precision. This is
      // the "clearing-sweep precision trap" the setter is deliberately built to avoid.
      const [snap] = await tx.execute<{ dirty_at: string | null }>(sql`
        select knowledge_dirty_at::text as dirty_at from ${projects} where ${projects.id} = ${project.id}
      `)
      const dirtyAt = snap?.dirty_at
      if (!dirtyAt) return null // cleared out from under us before we locked; nothing to do

      const n = await extractProject(tx, project.id, redactionPatterns)

      // Clear ONLY if the marker still equals the snapshot we took. A thread that
      // closed while we were processing bumped knowledge_dirty_at to a newer instant;
      // clearing unconditionally would drop that work. Leaving the marker means the
      // next sweep re-runs - idempotent, since already-extracted threads are skipped.
      await tx.execute(sql`
        update ${projects} set knowledge_dirty_at = null
        where ${projects.id} = ${project.id} and knowledge_dirty_at::text = ${dirtyAt}
      `)
      return n
    })
    if (written !== null) {
      processed++
      candidates += written
    }
  }

  return { projects: processed, candidates }
}

/**
 * Extract candidates for every closed/answered thread in the project that does not
 * already have one. Returns how many were written. Runs inside the caller's locked
 * transaction, so it is the single writer for this project.
 */
async function extractProject(
  tx: DbOrTx,
  projectId: string,
  redactionPatterns: readonly string[],
): Promise<number> {
  // Threads eligible for extraction with no existing candidate citing them. The
  // NOT EXISTS is the once-per-thread dedup: a candidate whose source_refs contain
  // {threadId} means this thread was already extracted.
  const eligible = await tx
    .select({ id: threads.id, subject: threads.subject })
    .from(threads)
    .where(and(
      eq(threads.projectId, projectId),
      inArray(threads.status, EXTRACTABLE_STATUSES as unknown as string[]),
      sql`not exists (
        select 1 from ${knowledge} k
        where k.project_id = ${projectId}
          and k.source_refs @> ${sql`jsonb_build_array(jsonb_build_object('threadId', ${threads.id}))`}
      )`,
    ))

  let written = 0
  for (const thread of eligible) {
    const msgs = await tx
      .select({ body: messages.body, fromAgentId: messages.fromAgentId, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.threadId, thread.id))
      .orderBy(messages.createdAt)

    const candidate = extractCandidateFromThread(
      { threadId: thread.id, subject: thread.subject, messages: msgs },
      redactionPatterns,
    )
    if (!candidate) continue // nothing substantive, or redacted to nothing

    // A double-check against the once-per-thread rule under the lock: insert only if
    // still no candidate cites this thread. With the advisory lock held this cannot
    // race another worker, but it also guards a re-run that raced its own clear.
    const [existing] = await tx
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(
        eq(knowledge.projectId, projectId),
        sql`${knowledge.sourceRefs} @> ${JSON.stringify([{ threadId: thread.id }])}::jsonb`,
      ))
      .limit(1)
    if (existing) continue

    await tx.insert(knowledge).values({
      projectId,
      kind: candidate.kind,
      title: candidate.title,
      body: candidate.body,
      sourceKind: 'thread',
      sourceRefs: candidate.sourceRefs,
      // ALWAYS candidate. The extractor never writes trusted - promotion is a
      // separate K-independent-issuer decision. This is what makes automatic
      // extraction safe: a crude auto-candidate nobody promotes never reaches recall.
      validationState: 'candidate',
    })
    written++
  }
  return written
}

/**
 * True when a project currently has the dirty marker set (diagnostics/tests). The
 * marker is RAISED by `markProjectKnowledgeDirty` in @relayroom/db - the single
 * cross-package setter every closer (server close tool, autoclose, web) shares, so
 * the rule lives in one place. This module only reads and clears it.
 */
export async function isProjectDirty(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNotNull(projects.knowledgeDirtyAt)))
    .limit(1)
  return !!row
}
