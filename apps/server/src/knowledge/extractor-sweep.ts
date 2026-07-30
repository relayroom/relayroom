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
 * WHICH THREADS a dirty project's sweep processes: the marker is project-level, so
 * the sweep considers every closed/answered thread and skips the ones already decided.
 * Each thread once, idempotent, bounded by un-decided threads.
 *
 * "ALREADY DECIDED" IS A `thread_extraction` ROW - the per-thread watermark L3 once
 * deferred (BUG-0010, 0.5.2). It replaced a rule that read "a candidate whose
 * sourceRefs cite the thread", and that rule was wrong for a reason worth keeping in
 * mind: a knowledge row is EVIDENCE that extraction happened, not a RECORD of it, and
 * two shipped paths delete the evidence while the thread's messages remain - retention's
 * hard delete, and purge. So the sweep re-extracted and wrote the candidate back. For
 * purge, the operator's remedy for a leaked secret, the remedy silently undid itself.
 *
 * The old source_refs predicate is STILL CHECKED alongside the watermark, but it is
 * NOT what protects against resurrection - the claim in extractProject is. See there
 * for what the predicate is actually still doing and what removing it would cost.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { knowledge, messages, projects, threadExtractions, threads } from '@relayroom/db'
import { extractCandidateFromThread } from './extract'
import { reportSkippedPatterns, skippedPatterns } from './redaction'

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

  // Ids only. The project's knowledge_config is deliberately NOT read here - see the
  // re-read under the lock below.
  const dirty = await db
    .select({
      id: projects.id,
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
      //
      // The REDACTION PATTERNS come from this same read, and the reason is a hazard,
      // not tidiness: a candidate is written with whatever patterns this snapshot holds,
      // and the write leaves a durable thread_extraction claim that stops the thread from
      // ever being reconsidered. So a pattern read from BEFORE the lock can redact with a
      // rule the owner has already replaced, store the secret the new rule was added to
      // remove, and then permanently mark the thread as handled. The marker being fresh
      // does not help - the sweep would see the new marker and still use the old patterns.
      // Anything the extraction depends on has to be read where the marker is read.
      const [snap] = await tx.execute<{ dirty_at: string | null; patterns: string[] | null }>(sql`
        select knowledge_dirty_at::text as dirty_at,
               knowledge_config -> 'redactionPatterns' as patterns
          from ${projects} where ${projects.id} = ${project.id}
      `)
      const dirtyAt = snap?.dirty_at
      if (!dirtyAt) return null // cleared out from under us before we locked; nothing to do

      const n = await extractProject(tx, project.id, snap?.patterns ?? [])

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
  // Once per project, not per thread: a pattern that cannot run cannot run for any of
  // them, so this says the same thing at a fraction of the volume. Reported rather than
  // enforced - a broken pattern must not stop the sweep - but never silent, because a
  // skipped pattern and a working denylist look identical from outside.
  reportSkippedPatterns(projectId, 'extractor', skippedPatterns(redactionPatterns))

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
      // The watermark (BUG-0010). A knowledge row is EVIDENCE of extraction; this is
      // the RECORD of it, and it outlives the row that purge or retention deletes.
      sql`not exists (
        select 1 from ${threadExtractions} te
        where te.project_id = ${projectId} and te.thread_id = ${threads.id}
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
    // NOTHING WORTH KEEPING IS NOT A DECISION. No watermark here, deliberately: this
    // is the current output of a function over inputs that CHANGE - the project's
    // redactionPatterns are editable and the rule itself changes on deploy - so
    // marking it would convert "no lesson found yet" into "never look again", on
    // exactly the threads a corrected pattern would recover. Re-reading them on a
    // later tick is what today already does, and it cannot duplicate anything.
    if (!candidate) continue // nothing substantive, or redacted to nothing

    // CLAIM THE THREAD, and let the claim be the guard (BUG-0010).
    //
    // This replaces a double-check that re-read `knowledge` here. A plain NOT EXISTS
    // cannot serialize against an UNCOMMITTED purge: we would see no row, insert the
    // candidate, and meet the purge only afterwards. Two writers contending for the
    // same primary key must queue on it, so the claim row is the serialization point:
    //   purge commits first -> our insert conflicts, returns nothing, we write nothing
    //   we claim first      -> purge waits, then its scan finds and removes our row
    // `do nothing` also means we can never revert a `purged` mark back to `extracted`.
    //
    // The `not exists` on knowledge is CARRIED OVER from the check this replaces, and
    // what it is actually for was settled by mutation-testing rather than by argument.
    // Disabling it alone changes nothing; disabling the claim alone changes nothing;
    // only disabling BOTH resurrects a purged candidate. So:
    //   - THE CLAIM is the resurrection protection. This clause is not.
    //   - This clause's one independent job is the `learn` race: `learn` inserts a row
    //     citing this thread WITHOUT taking our advisory lock (mcp.ts learn tool), so a
    //     `learn` committing between the eligibility query and here is skipped only
    //     because of this. Nothing else covers that.
    // Which means removing it - as the extraction-quality design will, moving to
    // watermark-only - costs exactly the `learn` race guard and nothing else. Solve
    // that race in the same change; do not just delete the line.
    //
    // The ownership `exists` is not ceremony either: the thread could have been
    // deleted since the eligibility query, and an FK violation here would abort the
    // whole project's sweep rather than skipping one thread.
    const claimed = await tx.execute<{ thread_id: string }>(sql`
      insert into ${threadExtractions} (project_id, thread_id, reason)
      select ${projectId}, ${thread.id}, 'extracted'
       where exists (
               select 1 from ${threads} t
                where t.id = ${thread.id} and t.project_id = ${projectId}
             )
         and not exists (
               select 1 from ${knowledge} k
                where k.project_id = ${projectId}
                  and k.source_refs @> ${JSON.stringify([{ threadId: thread.id }])}::jsonb
             )
      on conflict (project_id, thread_id) do nothing
      returning thread_id
    `)
    // Zero rows: a conflict, a deleted thread, or a knowledge row that appeared under
    // us. They are indistinguishable from here and all three mean the same thing.
    if (claimed.length === 0) continue

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
