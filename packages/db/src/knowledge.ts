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
import { knowledge, knowledgeAudits, knowledgeValidations } from './schema'

/** Driver-agnostic db handle, or a transaction. See governance.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KnowledgeDb = PgDatabase<any, any, any>

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
  /** The state after this call. */
  state: KnowledgeState | null
  /** Whether this call is the one that changed the state (and wrote the audit). */
  changed: boolean
  /** Distinct promoting issuers counted, and contradictions inside the window. */
  promotingIssuers: number
  contradictions: number
}

const NOT_FOUND: RecordKnowledgeSignalResult = {
  ok: false, recorded: false, state: null, changed: false, promotingIssuers: 0, contradictions: 0,
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
      .returning({ id: knowledgeValidations.id })
    const recorded = inserted.length > 0

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

    const settled = { recorded, promotingIssuers, contradictions }

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
