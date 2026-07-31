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
 * THE WATERMARK IS NOW THE WHOLE GUARD. The old `source_refs` predicate - "skip a
 * thread that any knowledge row cites" - is gone, and the reason it could go is that
 * the two were never asking the same question. The watermark records that this thread's
 * knowledge was DECIDED. A citation records only that someone mentioned the thread, and
 * `learn` writes one without deciding anything.
 *
 * So a `learn` row citing a thread no longer stops that thread from being extracted, and
 * both rows existing is correct rather than a duplicate: they are different acts with
 * different content. Two places had already settled this before the predicate went -
 * migration 0022's backfill deliberately excludes `learn` rows ("backfilling them would
 * make an incidental suppression permanent"), and the release contract's acceptance net
 * says `learn` rows citing an extracted thread are allowed. The act that DOES mean "this
 * thread is decided" is `close` carrying a lesson, which takes the watermark.
 *
 * One-time effect on an existing installation: a thread that only a pre-0022 `learn` row
 * cited becomes extractable and gets one candidate, once. Measured on the production hub
 * before the change: 8 threads.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { knowledge, messages, projects, threadExtractions, threads } from '@relayroom/db'
import { extractCandidateFromThread } from './extract'
import type { RedactionRule } from '@relayroom/shared'
import { reportSkippedPatterns, REDACTION_INPUT_SNAPSHOT, REDACTION_INPUT_SNAPSHOT_P, resolveRedactionRules, skippedPatterns } from '@relayroom/shared'


/**
 * Thrown when a project's redaction rules change while its sweep is mid-flight.
 *
 * Rolls the whole project transaction back rather than skipping a thread: a claim
 * written and then abandoned would foreclose that thread forever with nothing stored,
 * so partial work under superseded rules is not something to keep. The dirty marker is
 * left set by construction - the clear is the last statement and never runs - so the
 * next tick redoes the project under the new rules.
 */
class StaleRedactionRules extends Error {
  constructor(readonly projectId: string) {
    super(`redaction rules changed mid-sweep for project ${projectId}`)
    this.name = 'StaleRedactionRules'
  }
}

/** Advisory-lock namespace for the extractor, so its keys cannot collide with
 *  another subsystem's advisory locks on the same hashed project id. */
const EXTRACTOR_LOCK_NAMESPACE = 0x4b4e4f57 // 'KNOW'

/** Max dirty projects handled per tick. */
export const EXTRACTOR_PROJECT_BATCH = 50

/**
 * Thread statuses whose closure feeds the extractor. **`'closed'` only.**
 *
 * `'answered'` was here and is not a resolution: it is a live thread the dashboard has
 * marked as having an answer, and it can go on receiving messages. Extracting it froze a
 * mid-conversation snapshot PERMANENTLY, because extraction is once-per-thread - the
 * watermark makes the premature answer the only answer.
 *
 * The trade is stated rather than sold as free: for a long-lived answered thread, today
 * produces something and this produces nothing until it closes. What today produces is the
 * frozen snapshot above, so the trade is a premature answer for a later correct one.
 *
 * It relies on autoclose actually running - it treats `'answered'` as active and closes it
 * after the idle window, so the wait is bounded at roughly that window rather than forever.
 * If autoclose were ever disabled, this delay becomes unbounded, and that dependency is the
 * reason to name it here rather than in a commit message.
 */
const EXTRACTABLE_STATUSES = ['closed'] as const

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
    const written = await runProjectTick(db, project.id).catch((err) => {
      if (err instanceof StaleRedactionRules) {
        console.warn(`[knowledge] extractor: ${err.message}; rolled back and left the marker for the next tick`)
        return null
      }
      throw err
    })
    if (written !== null) {
      processed++
      candidates += written
    }
  }

  return { projects: processed, candidates }
}

async function runProjectTick(db: Db, projectId: string): Promise<number | null> {
  {
    const project = { id: projectId }
    return db.transaction(async (tx) => {
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
      // ever being reconsidered. So patterns read from a stale point can redact with a rule
      // the owner has already replaced, store the secret the new rule was added to remove,
      // and then permanently mark the thread as handled. Anything the extraction depends on
      // has to be read where the marker is read.
      //
      // DELIBERATELY NOT LOCKED, and the history is the reason. A previous fix took
      // `for update` here so that a settings save could not commit between this read and
      // the write. It did close the window, and it created a worse problem: the sweep then
      // takes the project row BEFORE the per-thread watermark, while the close path takes
      // the watermark before the project marker. Two paths acquiring the same pair in
      // opposite orders deadlock, and Postgres resolves that by killing one - delivering
      // an ordinary refusal as a crash.
      //
      // A global lock order would fix it, and would be a defence every future writer has to
      // remember. The requirement was never "serialize the settings writer against the
      // sweep". It is "never write a candidate under a rule that has already been
      // replaced", and that needs a comparison, not an order: the claim below writes only
      // if these patterns are still current. See there.
      //
      // RECOVERY IS CONDITIONAL, and the two cases are worth stating because "fix the
      // pattern and it comes back" is only half true:
      //   - extraction produced NOTHING -> no watermark was written -> a corrected pattern
      //     does bring the thread back, once the project goes dirty again. Which is why the
      //     settings writer has to call markProjectKnowledgeDirty; without that this case
      //     waits on some unrelated thread closing.
      //   - extraction produced a CANDIDATE -> it is claimed, and the claim is what the next
      //     sweep checks. A corrected pattern NEVER reaches it. The operator's remedy for
      //     that thread is purge, which removes the row and marks the thread purged.
      // Anyone tempted to make the first case cover the second should notice that the second
      // is exactly what BUG-0010's watermark exists to make permanent.
      const [snap] = await tx.execute<{
        dirty_at: string | null
        config: { redactionRules?: RedactionRule[]; redactionPatterns?: unknown } | null
        rules_text: string
      }>(sql`
        select knowledge_dirty_at::text as dirty_at,
               knowledge_config as config,
               ${sql.raw(REDACTION_INPUT_SNAPSHOT)} as rules_text
          from ${projects} where ${projects.id} = ${project.id}
      `)
      const dirtyAt = snap?.dirty_at
      if (!dirtyAt) return null // cleared out from under us before we locked; nothing to do

      // RESOLVE BEFORE EXTRACTING, and refuse the whole project if anything in the
      // configuration cannot be turned into a pattern. A rule we cannot resolve is a
      // protection the owner switched on and we are not applying; reporting it and
      // writing anyway would be observation rather than protection, and what the
      // invariant forbids is the storage, not the silence.
      //
      // Nothing is claimed on this path, so the refusal is a DEFERRAL rather than a
      // loss: fix the catalogue (or the configuration) and these threads extract on a
      // later tick. That property is inherited from BUG-0010's decision not to
      // watermark an empty extraction, and this is the second time it has paid.
      const { patterns, unresolved } = resolveRedactionRules(snap?.config)
      if (unresolved.length > 0) {
        console.warn(
          `[knowledge] extractor: refusing to write for project ${project.id} - `
          + `${unresolved.length} redaction rule(s) could not be resolved: `
          + unresolved.map(u => `${u.reason}(${u.detail})`).join(', '),
        )
        return null
      }

      const { written: n, staleConfig } = await extractProject(
        tx, project.id, patterns, snap?.rules_text ?? 'null',
      )

      // A settings save landed between two threads, caught by the claim guard before
      // anything was written for the current one. Leave the marker so the next tick redoes
      // the remainder under the new rules, and KEEP what earlier threads produced: each of
      // those rows passed the same comparison on its own insert, so each was written under
      // rules that were current at that moment.
      //
      // The other order - guard passes on the claim, fails on the candidate insert - cannot
      // keep anything, because it leaves a claim with no row behind it. That path throws
      // and the transaction rolls back. Same cause, different remedy, and the difference is
      // whether an orphan claim exists.
      if (staleConfig) {
        console.warn(
          `[knowledge] extractor: redaction patterns changed mid-sweep for project ${project.id};`
          + ' stopping early and leaving the dirty marker for the next tick',
        )
        return n
      }

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
  }
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
  /** The project's rules as Postgres renders them, for the comparison on the claim below.
   *  Taken from the database rather than re-serialised in JS so that the two sides of the
   *  comparison cannot disagree about key order, spacing or escaping. */
  patternsSnapshot: string,
): Promise<{ written: number; staleConfig: boolean }> {
  // Once per project, not per thread: a pattern that cannot run cannot run for any of
  // them, so this says the same thing at a fraction of the volume. Reported rather than
  // enforced - a broken pattern must not stop the sweep - but never silent, because a
  // skipped pattern and a working denylist look identical from outside.
  reportSkippedPatterns(projectId, 'extractor', skippedPatterns(redactionPatterns))

  // Threads eligible for extraction that nothing has decided yet. ONE PREDICATE, not
  // two: "already decided" is the watermark and nothing else. It used to also skip a
  // thread that any knowledge row cited, which is a different question - see the file
  // header for why those two came apart.
  //
  // HALF OF A PAIR. The other half is the `on conflict do nothing` on the claim below,
  // and the two cover each other: this one keeps decided threads out of the loop, and
  // the claim catches anything decided between this query and that insert. MEASURED, so
  // that "redundant" is not something the next reader has to guess at: removing either
  // one alone leaves the whole server suite green (388 passed), and only removing both
  // is red (4 failed in extractor-resurrection). So no test can tell you this line is
  // doing anything - which is exactly why deleting it as dead weight is easy, and why
  // correctness would then rest on the claim alone with nothing saying so.
  const eligible = await tx
    .select({ id: threads.id, subject: threads.subject })
    .from(threads)
    .where(and(
      eq(threads.projectId, projectId),
      inArray(threads.status, EXTRACTABLE_STATUSES as unknown as string[]),
      // The watermark (BUG-0010). A knowledge row is EVIDENCE of extraction; this is
      // the RECORD of it, and it outlives the row that purge or retention deletes.
      sql`not exists (
        select 1 from ${threadExtractions} te
        where te.project_id = ${projectId} and te.thread_id = ${threads.id}
      )`,
    ))
    // OLDEST FIRST, and this is a property rather than tidiness. A tick can stop
    // part-way - a rule change caught at the claim leaves the remaining threads for the
    // next one - so this order decides WHICH threads get written before the stop. Without
    // it that was whatever order the heap happened to return, which also means a test can
    // depend on insertion order and be right most of the time; review loop 9 flagged
    // exactly that assumption in extractor-stale-patterns and it was left standing.
    // `id` breaks ties: uuidv7 is time-ordered, so it agrees with created_at rather than
    // fighting it.
    .orderBy(threads.createdAt, threads.id)

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
    // redactionRules are editable and the catalogue changes on deploy - so
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
    // The `not exists` on knowledge that used to sit here IS GONE (0.6.0), and this
    // paragraph is kept because the argument for restoring it is persuasive and wrong.
    // It read: the clause's one independent job is the `learn` race - a `learn` committing
    // between the eligibility query and this claim is skipped only because of it - so
    // removing it costs that guard and nothing else, solve the race in the same change.
    //
    // Every sentence of that is true except the last. Both rows appearing is not a defect:
    // a `learn` row is a CITATION, and this claim records a DECISION. Migration 0022's
    // backfill already excluded `learn` rows for that reason, and the release contract
    // allows a `learn` row and an extracted candidate to cite one thread. Restoring the
    // clause as a "race fix" re-suppresses extraction for any thread an agent happened to
    // mention, which is the behaviour 0.6.0 removed on purpose.
    //
    // See the file header for the whole account, including what it cost on an existing
    // installation (8 threads, counted).
    //
    // The ownership `exists` is not ceremony either: the thread could have been
    // deleted since the eligibility query, and an FK violation here would abort the
    // whole project's sweep rather than skipping one thread.
    // THE PATTERN COMPARISON rides on this statement, and it has to be THIS statement
    // rather than a check before it. The candidate was redacted with these patterns;
    // if the owner replaced them since, that body is the wrong body and must not be
    // stored. Checking beforehand leaves a gap between the check and the write; checking
    // here means the claim and the comparison commit or fail together, which is the same
    // property the claim already gives against a competing purge.
    //
    // `is not distinct from` rather than `=`: a project with no patterns has SQL NULL
    // here, and `null = null` is null, which would fail the guard for every project that
    // never configured anything - i.e. all of them today.
    const claimed = await tx.execute<{ thread_id: string }>(sql`
      insert into ${threadExtractions} (project_id, thread_id, reason)
      select ${projectId}, ${thread.id}, 'extracted'
       where exists (
               select 1 from ${threads} t
                where t.id = ${thread.id} and t.project_id = ${projectId}
             )
         and exists (
               select 1 from ${projects} p
                where p.id = ${projectId}
                  and ${sql.raw(REDACTION_INPUT_SNAPSHOT_P)} = ${patternsSnapshot}
             )
      -- The other half of the pair described at the eligibility query above: that one
      -- keeps decided threads out of the loop, this one catches anything decided in
      -- between. Neither alone can be shown red by a test (388 passed with either one
      -- removed; 4 failed with both), so if you are removing one as redundant, you are
      -- removing a guard the suite cannot defend.
      on conflict (project_id, thread_id) do nothing
      returning thread_id
    `)
    if (claimed.length === 0) {
      // Zero rows has several causes and only one of them invalidates the rest of this
      // project's work, so they have to be told apart. A conflict - another sweep, a
      // purge, or a `close` that carried a lesson - and a deleted thread are both "skip
      // this thread". Patterns having changed is "stop, and let the next tick redo the
      // remainder".
      const [now] = await tx.execute<{ snapshot: string }>(sql`
        select ${sql.raw(REDACTION_INPUT_SNAPSHOT)} as snapshot
          from ${projects} where ${projects.id} = ${projectId}
      `)
      if (now && now.snapshot !== patternsSnapshot) return { written, staleConfig: true }
      continue
    }

    // THE SAME COMPARISON, ON THE WRITE THAT STORES THE TEXT. Guarding only the claim
    // was not enough, and the gap is narrow enough to have looked like nothing: the
    // claim and this insert are separate statements, Read Committed gives each its own
    // snapshot, so a settings save committing between them left the claim validated
    // against the old rules and the CANDIDATE - the row that actually holds the secret -
    // written under them anyway. Permanently, because the claim is what the next sweep
    // reads. Found by review loop 9, one loop after "the comparison rides on the claim"
    // was written down as the fix.
    //
    // The lesson is narrower than "check twice": the guard has to be on the statement
    // that writes the sensitive bytes, not on a statement that happens to precede it.
    const stored = await tx.execute<{ id: string }>(sql`
      insert into ${knowledge} (project_id, kind, title, body, source_kind, source_refs, validation_state)
      select ${projectId}, ${candidate.kind}, ${candidate.title}, ${candidate.body},
             'thread', ${JSON.stringify(candidate.sourceRefs)}::jsonb,
             -- ALWAYS candidate. The extractor never writes trusted; promotion is a
             -- separate K-independent-issuer decision, and that is what makes automatic
             -- extraction safe - a crude auto-candidate nobody promotes never reaches recall.
             'candidate'
       where exists (
               select 1 from ${projects} p
                where p.id = ${projectId}
                  and ${sql.raw(REDACTION_INPUT_SNAPSHOT_P)} = ${patternsSnapshot}
             )
      returning id
    `)
    if (stored.length === 0) {
      // The rules changed between the claim and this insert. The claim is now a
      // watermark with nothing behind it, which would foreclose the thread forever, so
      // the ENTIRE project transaction has to go - claims and candidates from earlier
      // threads in this tick included. The marker is never cleared on this path, so the
      // next tick redoes all of it under the new rules.
      throw new StaleRedactionRules(projectId)
    }
    written++
  }
  return { written, staleConfig: false }
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
