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
import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { PgDatabase } from 'drizzle-orm/pg-core'
import {
  knowledge,
  knowledgeAudits,
  knowledgeProposals,
  knowledgeValidations,
  playbookVersions,
  projects,
} from './schema'

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

// ── Reflection proposer (L4) ───────────────────────────────────────────────────
// The loop-closer. A recurring failure signature becomes a PROPOSED knowledge or
// playbook diff, which a human decides. These three functions live beside the
// promotion transaction on purpose: the trust boundary they must not cross is the
// same one it enforces, and keeping them together is what makes it reviewable that
// approving a proposal is intake, not promotion.

export type ProposalTarget = 'knowledge' | 'playbook'
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded'

export interface ProposeKnowledgeDiffInput {
  projectId: string
  target: ProposalTarget
  evidence?: { signature?: string; eventIds?: string[]; knowledgeIds?: string[]; count?: number; agents?: number }
  hypothesis: string
  disconfirming?: string | null
  /**
   * The concrete change. For target=knowledge: { title, body, kind, claimType }.
   * For target=playbook: { content } - the full proposed authored body. The
   * proposer resolves any diff into that snapshot (a `patch` may ride along for the
   * human to read), because the db layer applies no diffs: playbook_version stores
   * a full snapshot, and decideProposal writes exactly what it is given.
   */
  change: Record<string, unknown>
  triggerSignature?: string | null
  createdByJob?: string
}

/**
 * Queue a pending proposal, idempotently. The partial unique index allows only one
 * OPEN proposal per (project, signature), so a signature already queued does not
 * double-queue; the ON CONFLICT makes that a silent no-op rather than an error.
 * Returns the inserted row, or null when an open proposal for the signature already
 * exists (or when there is no signature to dedupe on and the insert still races -
 * callers treat null as "already queued").
 */
export async function proposeKnowledgeDiff(
  db: KnowledgeDb,
  input: ProposeKnowledgeDiffInput,
): Promise<typeof knowledgeProposals.$inferSelect | null> {
  const inserted = await db
    .insert(knowledgeProposals)
    .values({
      projectId: input.projectId,
      target: input.target,
      evidence: input.evidence ?? {},
      hypothesis: input.hypothesis,
      disconfirming: input.disconfirming ?? null,
      change: input.change,
      triggerSignature: input.triggerSignature ?? null,
      ...(input.createdByJob ? { createdByJob: input.createdByJob } : {}),
    })
    .onConflictDoNothing({
      target: [knowledgeProposals.projectId, knowledgeProposals.triggerSignature],
      where: sql`status = 'pending'`,
    })
    .returning()
  return inserted[0] ?? null
}

export interface DecideProposalInput {
  projectId: string
  proposalId: string
  decision: 'approved' | 'rejected'
  userId: string
  /** Optional note carried onto the playbook_version / audit for a playbook approve. */
  note?: string
}

export type DecideProposalResult =
  | { ok: false; reason: 'not_found' }
  /** Already decided; nothing was written. `status` is the terminal state it holds. */
  | { ok: false; reason: 'not_pending'; status: ProposalStatus }
  | {
      ok: true
      status: 'approved' | 'rejected'
      target: ProposalTarget
      auditId: string
      /** Set when an approved knowledge proposal created a candidate. */
      knowledgeId?: string
      /** Set when an approved playbook proposal wrote a new version. */
      version?: number
    }

/**
 * Decide a pending proposal under a row lock. Re-deciding is a no-op (mirrors the
 * promotion transaction's change-only audit), so a double-click or a retry cannot
 * write a second audit or apply the change twice.
 *
 * The load-bearing rule: **an approved knowledge proposal is written as a
 * `candidate` with source_kind='proposer', never trusted.** A human approving the
 * PROPOSAL is saying "this is worth keeping", not "this fact is proven"; promotion
 * still requires K independent issuers through the promotion transaction. Setting
 * trusted here would turn one dashboard click into a K=1 promotion that bypasses
 * the whole attestation model, which is the one place L4 could quietly break the
 * trust boundary.
 */
export async function decideProposal(
  db: KnowledgeDb,
  input: DecideProposalInput,
): Promise<DecideProposalResult> {
  return db.transaction(async tx => {
    const [proposal] = await tx
      .select()
      .from(knowledgeProposals)
      .where(and(
        eq(knowledgeProposals.id, input.proposalId),
        eq(knowledgeProposals.projectId, input.projectId),
      ))
      .for('update')
    if (!proposal) return { ok: false, reason: 'not_found' }
    if (proposal.status !== 'pending') {
      return { ok: false, reason: 'not_pending', status: proposal.status as ProposalStatus }
    }

    const target = proposal.target as ProposalTarget
    const approved = input.decision === 'approved'
    let knowledgeId: string | undefined
    let version: number | undefined

    if (approved && target === 'knowledge') {
      // Intake, not promotion: a candidate, with the proposer as its source.
      const change = proposal.change as { title?: string; body?: string; kind?: string }
      const [row] = await tx
        .insert(knowledge)
        .values({
          projectId: input.projectId,
          kind: change.kind ?? 'pitfall',
          title: change.title ?? proposal.hypothesis,
          body: change.body ?? '',
          sourceKind: 'proposer',
          validationState: 'candidate',
        })
        .returning({ id: knowledge.id })
      knowledgeId = row!.id
    }
    else if (approved && target === 'playbook') {
      version = await appendPlaybookVersion(tx, {
        projectId: input.projectId,
        content: playbookContentFrom(proposal.change),
        note: input.note ?? `proposal ${proposal.id}`,
        proposalId: proposal.id,
        userId: input.userId,
      })
    }

    // The audit is always written, on approve and reject alike, so the queue has a
    // full decision history. knowledgeId links an approved knowledge candidate.
    const [audit] = await tx
      .insert(knowledgeAudits)
      .values({
        projectId: input.projectId,
        action: approved ? 'proposer_approve' : 'proposer_reject',
        knowledgeId: knowledgeId ?? null,
        actorKind: 'human',
        actorUserId: input.userId,
        detail: { proposalId: proposal.id, target, ...(version ? { playbookVersion: version } : {}) },
      })
      .returning({ id: knowledgeAudits.id })

    await tx
      .update(knowledgeProposals)
      .set({
        status: approved ? 'approved' : 'rejected',
        decidedByUserId: input.userId,
        decidedAt: sql`now()`,
        auditId: audit!.id,
        updatedAt: sql`now()`,
      })
      .where(eq(knowledgeProposals.id, proposal.id))

    return {
      ok: true,
      status: approved ? 'approved' : 'rejected',
      target,
      auditId: audit!.id,
      ...(knowledgeId ? { knowledgeId } : {}),
      ...(version ? { version } : {}),
    }
  })
}

export interface RollbackPlaybookInput {
  projectId: string
  toVersion: number
  userId: string
  note?: string
}

export type RollbackPlaybookResult =
  | { ok: false; reason: 'version_not_found' }
  | { ok: true; version: number; rolledBackTo: number; auditId: string }

/**
 * Roll the served playbook back to a prior version's content by APPENDING a new
 * version equal to it - never mutating or deleting a version row. Blind overwrite
 * is what this exists to avoid: the history stays a faithful record, and a rollback
 * is itself a versioned, audited event that can in turn be rolled back.
 */
export async function rollbackPlaybook(
  db: KnowledgeDb,
  input: RollbackPlaybookInput,
): Promise<RollbackPlaybookResult> {
  return db.transaction(async tx => {
    const [target] = await tx
      .select({ content: playbookVersions.content })
      .from(playbookVersions)
      .where(and(
        eq(playbookVersions.projectId, input.projectId),
        eq(playbookVersions.version, input.toVersion),
      ))
    if (!target) return { ok: false, reason: 'version_not_found' }

    const version = await appendPlaybookVersion(tx, {
      projectId: input.projectId,
      content: target.content,
      note: input.note ?? `rollback to v${input.toVersion}`,
      proposalId: null,
      userId: input.userId,
    })

    const [audit] = await tx
      .insert(knowledgeAudits)
      .values({
        projectId: input.projectId,
        action: 'playbook_change',
        actorKind: 'human',
        actorUserId: input.userId,
        detail: { rolledBackTo: input.toVersion, newVersion: version },
      })
      .returning({ id: knowledgeAudits.id })

    return { ok: true, version, rolledBackTo: input.toVersion, auditId: audit!.id }
  })
}

/** The full authored body a playbook proposal snapshots. See ProposeKnowledgeDiffInput.change. */
function playbookContentFrom(change: Record<string, unknown>): string {
  const content = change.content
  if (typeof content !== 'string') {
    // The db layer applies no diffs; the proposer must resolve the change to a full
    // body in change.content. A bare patch with no content is not something this
    // function can turn into a snapshot, so fail loudly rather than store a lie.
    throw new Error('playbook proposal change.content must be the full authored body (string)')
  }
  return content
}

/**
 * Append a new playbook_version and point the live copy at it. Serialized per
 * project by locking the project row first, so two concurrent writers cannot pick
 * the same next version and collide on the unique (project, version) index.
 * Returns the new version number.
 */
async function appendPlaybookVersion(
  tx: KnowledgeDb,
  args: { projectId: string; content: string; note: string | null; proposalId: string | null; userId: string },
): Promise<number> {
  // Lock the project row so the max(version) read and the insert are one step.
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, args.projectId)).for('update')

  const [latest] = await tx
    .select({ version: playbookVersions.version })
    .from(playbookVersions)
    .where(eq(playbookVersions.projectId, args.projectId))
    .orderBy(desc(playbookVersions.version))
    .limit(1)
  const version = (latest?.version ?? 0) + 1
  const contentHash = createHash('sha256').update(args.content).digest('hex')

  await tx.insert(playbookVersions).values({
    projectId: args.projectId,
    version,
    content: args.content,
    contentHash,
    note: args.note,
    proposalId: args.proposalId,
    createdByUserId: args.userId,
  })
  await tx.update(projects).set({ relayroomMd: args.content, updatedAt: sql`now()` }).where(eq(projects.id, args.projectId))
  return version
}
