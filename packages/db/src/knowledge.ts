/**
 * Promotion and demotion of a knowledge entry, as one locked transaction.
 *
 * Lives in @relayroom/db rather than in a route because more than one caller has
 * to reach it and they must not each re-derive the rule: the CI attest endpoint,
 * the dashboard's human confirm, and the contradiction path all end here. Same
 * reasoning as ./governance.ts, and the same driver-agnostic handle, since the
 * Hono server and the Next app use different drizzle drivers.
 *
 * The order inside the transaction is the whole design and is not rearrangeable:
 *
 *   1. lock the knowledge row (FOR UPDATE), so two validations arriving at once
 *      cannot both read "K-1" and both promote;
 *   2. insert the validation, deduplicated on (knowledge, signal, source), so a
 *      re-run of the same CI job cannot manufacture a second voice;
 *   3. re-count, and update the state only from the state we expect;
 *   4. write the audit row ONLY if that update actually changed a row.
 *
 * Step 4 is why the count is not inserted-then-audited: an audit row for a
 * promotion that did not happen is worse than no audit at all, because the
 * history is the thing an operator later trusts.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { knowledge, knowledgeAudits, knowledgeValidations, projects } from './schema'

/** Driver-agnostic db handle, or a transaction. See governance.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KnowledgeDb = PgDatabase<any, any, any>

/**
 * Mark a project as having new closed-thread material for the extractor to sweep.
 *
 * Every place a thread reaches a resolved state has to call this, and those places
 * live in two packages: the Hono close tool and the autoclose sweep in apps/server,
 * and the dashboard's status change in apps/web. It sits in @relayroom/db so both
 * import the one setter - the same reason decideProjectAccess and the promotion
 * transaction live here. If instead the servers kept a private copy, the web
 * closer would quietly not mark, and every thread closed from the dashboard would
 * never be extracted, with no error to notice.
 *
 * It only WRITES now() - it never reads the marker back, so the microsecond
 * precision trap that the clearing side must avoid does not touch this side.
 * `now()` is the transaction's clock, so calling it inside the same transaction
 * that closes the thread ties the two together.
 */
export async function markProjectKnowledgeDirty(db: KnowledgeDb, projectId: string): Promise<void> {
  await db.update(projects).set({ knowledgeDirtyAt: sql`now()` }).where(eq(projects.id, projectId))
}

export interface PurgeResult {
  /** Entries whose sole source was this thread; removed entirely. */
  deleted: number
  /** Entries citing this thread and others; this thread stripped from sourceRefs. */
  detached: number
}

/**
 * Purge (or, with `dryRun`, count) the knowledge derived from a thread.
 *
 * An entry's `sourceRefs` is a provenance ledger and an ARRAY: one distilled lesson
 * can cite several threads. So purging thread A is not a blanket delete of anything
 * that mentions A:
 *   - an entry whose ONLY source was A is deleted;
 *   - an entry citing A and something else survives, with A stripped from its
 *     sourceRefs (detached).
 * Deleting on any-match would lose knowledge another thread contributed; detaching
 * only would leave a sourceRef pointing at a purged thread, so provenance would
 * lie. Doing both is the only outcome that leaves no reference to A anywhere and
 * loses no multi-source knowledge.
 *
 * The two counts are returned separately because the action is irreversible and the
 * dashboard preview must say exactly "N deleted, M detached" - collapsing them
 * would mislead the person confirming. `dryRun` computes those counts and writes
 * nothing, so the preview and the delete are the SAME function and cannot diverge
 * on what "derived from thread X" means. It is one transaction: a partial purge
 * would leave some entries detached and some not, and a retry would report
 * different numbers.
 *
 * This lives beside recordKnowledgeSignal for the same reason: the dashboard's
 * purge action calls it directly (its sibling `promoteKnowledge` already calls
 * recordKnowledgeSignal the same way), after checking owner access itself. A
 * button is not a gate, so the caller re-checks; there is no HTTP hop to add one.
 *
 * projectId is required and matched, so one project cannot purge another's
 * knowledge by naming its thread id.
 */
export async function purgeKnowledgeFromThread(
  db: KnowledgeDb,
  projectId: string,
  threadId: string,
  opts: { dryRun?: boolean } = {},
): Promise<PurgeResult> {
  // A dry run still runs in a transaction so its counts are a consistent snapshot,
  // but it writes nothing.
  return db.transaction(async tx => {
    // Every entry in this project that cites the thread. `@>` containment finds an
    // array element that includes {threadId}; the sole-vs-multi split is then decided
    // per row in JS, where the array semantics are clearest.
    const rows = await tx
      .select({ id: knowledge.id, sourceRefs: knowledge.sourceRefs })
      .from(knowledge)
      .where(and(
        eq(knowledge.projectId, projectId),
        sql`${knowledge.sourceRefs} @> ${JSON.stringify([{ threadId }])}::jsonb`,
      ))

    let deleted = 0
    let detached = 0
    for (const row of rows) {
      const remaining = (row.sourceRefs ?? []).filter(ref => ref.threadId !== threadId)
      if (remaining.length === 0) {
        deleted++
        if (!opts.dryRun) {
          await tx.delete(knowledge).where(eq(knowledge.id, row.id))
        }
      }
      else {
        detached++
        if (!opts.dryRun) {
          await tx.update(knowledge)
            .set({ sourceRefs: remaining, updatedAt: sql`now()` })
            .where(eq(knowledge.id, row.id))
        }
      }
    }
    return { deleted, detached }
  })
}

/**
 * Distinct promoting issuer identities required for automatic promotion. Two, so
 * that no single principal promotes alone: the entire CI system counts as one
 * issuer, so green runs by themselves never reach it. A project may lower or
 * raise it through `projects.knowledgeConfig.kDistinctIssuers`.
 */
export const PROMOTION_K_DEFAULT = 2

/**
 * How far back a contradiction still blocks promotion, in days. Overridable per
 * project through `projects.knowledgeConfig.windowDays`.
 *
 * **This number was picked, not derived.** No design document specifies it. It is
 * also inert at L0: nothing here creates a contradiction yet (`error_event` comes
 * with L1, and there is no human demotion path), so 30 and 90 behave identically
 * today. Do not read it as a tuned value.
 *
 * **Revisit it when the demotion path lands.** Promotion requires
 * `contradictions === 0` and that applies to the human owner override too, so a
 * single stale contradiction blocks a person from promoting an entry until the
 * window expires, and no UI clears it. That is where this number starts to hurt.
 */
export const CONTRADICTION_WINDOW_DAYS_DEFAULT = 30

/** Issuers whose support can promote. `error_event` is evidence, never a vote. */
const PROMOTING_ISSUERS = ['ci_attest', 'human'] as const

export type KnowledgeState = 'candidate' | 'trusted' | 'contradicted' | 'retired'
export type ValidationSignal = 'support' | 'contradict'
export type ValidationIssuer = 'ci_attest' | 'human' | 'error_event'
export type AuditActorKind = 'human' | 'ci' | 'system'

export interface RecordKnowledgeSignalInput {
  /** The project the caller is acting in. Checked against the entry, not trusted. */
  projectId: string
  knowledgeId: string
  signal: ValidationSignal
  issuer: ValidationIssuer
  /** Identity promotion counts DISTINCT over: userId, the project's CI issuer, 'error'. */
  issuerId: string
  /** Stable hash of issuer + sourceRef. The dedup key; the same source counts once. */
  sourceFingerprint: string
  sourceRef?: { runId?: string; userId?: string; eventId?: string }
  /** false for an attestation with no check mapping: recorded, never counted. */
  counted?: boolean
  weight?: number
  actorKind: AuditActorKind
  actorUserId?: string | null
  /**
   * A project owner deliberately confirming this entry, which promotes at K=1.
   * The caller is responsible for having verified that authority (the decision
   * itself is `decideProjectAccess` in @relayroom/shared); this flag only says
   * that it was verified, and it is recorded in the audit row.
   */
  humanOwnerOverride?: boolean
  /**
   * Written on promotion when given, left untouched when not. The verifier owns
   * this number: no document defines how it is computed, and a formula invented
   * here would be displayed on the dashboard as if it meant something.
   *
   * **The consequence is intended, not an oversight.** With no caller supplying
   * it, confidence stays 0, and recall's `similarity * (0.5 + confidence)`
   * ranking collapses to `similarity * 0.5` - a constant factor, so ordering is
   * pure similarity. That is the honest behaviour while nothing computes
   * confidence. It is not a bug where recall "ignores confidence".
   */
  confidence?: number
  /** Overrides for the project's configured thresholds. */
  k?: number
  windowDays?: number
}

export interface RecordKnowledgeSignalResult {
  /** false when no such entry exists IN THIS PROJECT. Nothing was written. */
  ok: boolean
  /** false when this exact issuer-source had already signalled the same way. */
  recorded: boolean
  /**
   * The validation this signal maps to: the row inserted now, or - on a dedup
   * no-op - the row already there for the same (knowledge, signal, source). null
   * only when nothing was written at all (the entry was not found). This is the
   * `validationId` the attest response returns, resolved inside the same locked
   * transaction so no caller re-queries by the dedup key from outside.
   */
  validationId: string | null
  /**
   * Whether that validation counts toward promotion - the STORED value, which on
   * a replay is the original insert's, not whatever this call passed. The other
   * half of the attest response contract. null only when nothing was written.
   */
  counted: boolean | null
  /** The state after this call. */
  state: KnowledgeState | null
  /** Whether this call is the one that changed the state (and wrote the audit). */
  changed: boolean
  /** Distinct promoting issuers counted, and contradictions inside the window. */
  promotingIssuers: number
  contradictions: number
}

const NOT_FOUND: RecordKnowledgeSignalResult = {
  ok: false, recorded: false, validationId: null, counted: null,
  state: null, changed: false, promotingIssuers: 0, contradictions: 0,
}

/**
 * Record one validation signal and re-evaluate the entry's state under a row lock.
 *
 * Returns `ok: false` when the entry does not exist **or belongs to another
 * project**. The two are deliberately indistinguishable: telling a caller that an
 * id exists elsewhere is itself a cross-tenant leak, and this is the write path a
 * project's CI secret reaches, so the project check is enforced here rather than
 * left to each caller to remember.
 *
 * Safe to call twice with the same input: the validation dedups, and the state
 * update is guarded on the state it expects, so the second call reports
 * `changed: false` and writes no second audit row.
 *
 * Pass a transaction to compose this into a larger unit of work; passing a plain
 * db handle is fine, and opens its own.
 */
export async function recordKnowledgeSignal(
  db: KnowledgeDb,
  input: RecordKnowledgeSignalInput,
): Promise<RecordKnowledgeSignalResult> {
  const k = input.k ?? PROMOTION_K_DEFAULT
  const windowDays = input.windowDays ?? CONTRADICTION_WINDOW_DAYS_DEFAULT

  return db.transaction(async tx => {
    // (1) The lock comes first, before anything is read or written. Every writer
    // for this entry queues here, which is what makes the count below a decision
    // and not a guess: without it two concurrent supports both read K-1.
    const [locked] = await tx
      .select({ state: knowledge.validationState })
      .from(knowledge)
      .where(and(eq(knowledge.id, input.knowledgeId), eq(knowledge.projectId, input.projectId)))
      .for('update')
    if (!locked) return NOT_FOUND
    const fromState = locked.state as KnowledgeState

    // (2) The validation, deduplicated in the schema on (knowledge, signal,
    // source). A no-op here is normal - a CI job re-run, a double-clicked confirm.
    const inserted = await tx
      .insert(knowledgeValidations)
      .values({
        knowledgeId: input.knowledgeId,
        signal: input.signal,
        issuer: input.issuer,
        issuerId: input.issuerId,
        sourceFingerprint: input.sourceFingerprint,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.counted === undefined ? {} : { counted: input.counted }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      })
      .onConflictDoNothing({
        target: [
          knowledgeValidations.knowledgeId,
          knowledgeValidations.signal,
          knowledgeValidations.sourceFingerprint,
        ],
      })
      .returning({ id: knowledgeValidations.id, counted: knowledgeValidations.counted })
    const recorded = inserted.length > 0

    // On a dedup no-op the insert returns nothing, but the caller still needs the
    // id it collided with (the attest response is idempotent - a replay returns
    // the original validation). Read it back HERE, under the same lock, rather
    // than making the server re-query by the dedup key: an external lookup on the
    // same key is the shape of bug that had a web subquery silently returning 0.
    let validation = inserted[0] ?? null
    if (!validation) {
      const [existing] = await tx
        .select({ id: knowledgeValidations.id, counted: knowledgeValidations.counted })
        .from(knowledgeValidations)
        .where(and(
          eq(knowledgeValidations.knowledgeId, input.knowledgeId),
          eq(knowledgeValidations.signal, input.signal),
          eq(knowledgeValidations.sourceFingerprint, input.sourceFingerprint),
        ))
      validation = existing ?? null
    }

    // (3) Re-count under the lock. Identities, not rows: a hundred green CI runs
    // share one issuer_id and are one voice.
    const [supportRow] = await tx
      .select({ n: sql<string>`count(distinct ${knowledgeValidations.issuerId})` })
      .from(knowledgeValidations)
      .where(and(
        eq(knowledgeValidations.knowledgeId, input.knowledgeId),
        eq(knowledgeValidations.signal, 'support'),
        eq(knowledgeValidations.counted, true),
        inArray(knowledgeValidations.issuer, [...PROMOTING_ISSUERS]),
      ))
    const [contraRow] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(knowledgeValidations)
      .where(and(
        eq(knowledgeValidations.knowledgeId, input.knowledgeId),
        eq(knowledgeValidations.signal, 'contradict'),
        gt(knowledgeValidations.createdAt, sql`now() - ${`${windowDays} days`}::interval`),
      ))
    const promotingIssuers = Number(supportRow?.n ?? 0)
    const contradictions = Number(contraRow?.n ?? 0)

    const settled = {
      recorded,
      validationId: validation?.id ?? null,
      counted: validation?.counted ?? null,
      promotingIssuers,
      contradictions,
    }

    if (input.signal === 'contradict') {
      // Demotion is immediate and applies to a trusted entry as much as to a
      // candidate: recall must stop returning something that has been refuted.
      // `promoted_at` is left in place - it is history, not current state.
      const demoted = await tx
        .update(knowledge)
        .set({ validationState: 'contradicted', updatedAt: sql`now()` })
        .where(and(
          eq(knowledge.id, input.knowledgeId),
          inArray(knowledge.validationState, ['candidate', 'trusted']),
        ))
        .returning({ id: knowledge.id })
      if (demoted.length === 0) {
        return { ok: true, ...settled, state: fromState, changed: false }
      }
      await writeAudit(tx, input, 'demote', fromState, 'contradicted', settled)
      return { ok: true, ...settled, state: 'contradicted', changed: true }
    }

    const qualifies = (promotingIssuers >= k || input.humanOwnerOverride === true)
      && contradictions === 0
    if (!qualifies) return { ok: true, ...settled, state: fromState, changed: false }

    // Only ever candidate -> trusted. The guard is in the WHERE, not in JS: it is
    // what makes a second identical call a no-op rather than a second audit row,
    // and it never resurrects something contradicted or retired.
    const promoted = await tx
      .update(knowledge)
      .set({
        validationState: 'trusted',
        promotedAt: sql`now()`,
        updatedAt: sql`now()`,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      })
      .where(and(
        eq(knowledge.id, input.knowledgeId),
        eq(knowledge.validationState, 'candidate'),
      ))
      .returning({ id: knowledge.id })
    if (promoted.length === 0) {
      return { ok: true, ...settled, state: fromState, changed: false }
    }
    await writeAudit(tx, input, 'promote', 'candidate', 'trusted', settled)
    return { ok: true, ...settled, state: 'trusted', changed: true }
  })
}

/** Written only after a state change, so the trail never claims one that did not happen. */
async function writeAudit(
  tx: KnowledgeDb,
  input: RecordKnowledgeSignalInput,
  action: 'promote' | 'demote',
  fromState: KnowledgeState,
  toState: KnowledgeState,
  counts: { promotingIssuers: number; contradictions: number },
) {
  await tx.insert(knowledgeAudits).values({
    projectId: input.projectId,
    action,
    knowledgeId: input.knowledgeId,
    fromState,
    toState,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    detail: {
      override: input.humanOwnerOverride === true,
      issuer: input.issuer,
      issuerId: input.issuerId,
      promotingIssuers: counts.promotingIssuers,
      contradictions: counts.contradictions,
    },
  })
}
