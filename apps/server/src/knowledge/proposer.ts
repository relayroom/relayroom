/**
 * Reflection proposer (FEAT-0005 L4) - the loop's back-arrow.
 *
 * A recurring failure or a refuted belief should not just accumulate; it should
 * come back as a PROPOSED change a human reviews. This job clusters recurring error
 * events (and surfaces contradicted knowledge), and for each pattern that clears a
 * threshold it drafts a proposal into the review queue. It NEVER applies anything and
 * NEVER messages an agent: the only surface is the dashboard queue (06 named playbook
 * self-modification as a risk, so the loop closes through a human, not around one).
 *
 * TRUST BOUNDARY. Every proposal is a CANDIDATE-in-waiting: approving one writes a
 * `candidate` knowledge row (core's decideProposal), never `trusted`. Promotion still
 * needs K independent non-agent issuers (04). So even a crude draft here cannot reach
 * recall on its own - the same reason the L3 extractor may be crude.
 *
 * STRUCTURE mirrors extractor-sweep.ts: periodic, leased single-writer per project
 * via a transaction-scoped advisory lock, durable (missing a tick is fine - the next
 * sweep re-clusters the same window). Idempotency is core's: proposeKnowledgeDiff
 * upserts on a (project, triggerSignature) open-proposal index, so re-running the
 * sweep over the same window does not double-queue a signature already pending. This
 * module's contract is only that it passes a STABLE triggerSignature per pattern.
 *
 * The `proposeKnowledgeDiff` call is injected (ProposeFn) rather than imported: at
 * L4 authoring time core's fn + the knowledge_proposal table are not yet on main, so
 * the sweep is written and tested against the injection point and wired to the real
 * @relayroom/db fn (and added to the scheduler) once core lands - the deliberate swap
 * point, like the L3 extractor's extract fn.
 *
 * SCOPE of this first cut (flagged to main): only ERROR-CLUSTER -> candidate `pitfall`
 * knowledge proposals are emitted. Two 07 inputs are deferred deliberately:
 *   - `contradicted` knowledge as a trigger: "approve" on a knowledge-target proposal
 *     CREATES a candidate from change.{title,body,kind} (core's decideProposal). A
 *     "review this refuted entry" proposal references an existing id and has no new
 *     candidate body, so it maps to neither documented approval behaviour. It needs a
 *     defined approval action before it can be shipped honestly.
 *   - playbook-note proposals: per main's contract, a target=playbook proposal must
 *     carry the FULL resolved authored body in change.content (db never applies a
 *     patch; decideProposal throws without content). Resolving the whole body is the
 *     proposer's job; deferred until the note templates are defined. When added, they
 *     follow that content-snapshot contract, with an optional change.patch for web.
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { events } from '@relayroom/db'
import { errorSignature } from './error-signature'

/** Advisory-lock namespace for the proposer, distinct from the extractor's so the
 *  two subsystems cannot collide on the same hashed project id. */
const PROPOSER_LOCK_NAMESPACE = 0x50524f50 // 'PROP'

/** A signature seen across at least this many DISTINCT agents drafts a proposal. */
export const PROPOSER_MIN_AGENTS = 2
/** ...OR seen at least this many times in the window (even by one agent). */
export const PROPOSER_MIN_COUNT = 3
/** How far back the sweep clusters error events. Chosen here (07 leaves it to the
 *  threshold from 04); tunable via config later if noisy. */
export const PROPOSER_WINDOW_DAYS = 7
/** Max projects handled per tick, so one busy project cannot hold the whole batch. */
export const PROPOSER_PROJECT_BATCH = 100
/** Cap on event ids carried as evidence, so a very hot signature cannot bloat a row. */
const MAX_EVIDENCE_EVENT_IDS = 20

/** The change/argument a proposal carries. Shape matches core's proposeKnowledgeDiff. */
export interface ProposalDraft {
  target: 'knowledge' | 'playbook'
  evidence: { signature?: string; eventIds?: string[]; knowledgeIds?: string[]; count?: number; agents?: number }
  hypothesis: string
  disconfirming?: string
  change: Record<string, unknown>
  triggerSignature?: string
}

/**
 * The core db function the proposer calls to enqueue a proposal. Injected so the
 * sweep can be built and tested before core's @relayroom/db implementation lands.
 * Returns the created row, or null when the (project, triggerSignature) open-proposal
 * index already has a pending entry (idempotent - already queued).
 */
export type ProposeFn = (
  tx: DbOrTx,
  input: { projectId: string } & ProposalDraft,
) => Promise<{ id: string } | null>

export interface ErrorCluster {
  signature: string
  count: number
  agents: number
  eventIds: string[]
  sampleDetail: Record<string, unknown>
}

export interface ProposerSweepResult {
  /** Projects whose lock was claimed and clustered this tick. */
  projects: number
  /** Proposals actually created (not counting idempotent no-ops). */
  proposals: number
}

/**
 * Cluster error-event rows by signature and keep only clusters that clear the
 * threshold (>= PROPOSER_MIN_AGENTS distinct agents OR >= PROPOSER_MIN_COUNT
 * occurrences). Null-signature events (no identifying detail) are dropped: they
 * cannot be a recurrence of anything and must not pool into one false pattern -
 * the same rule error-signature.ts applies for repeat_error. Pure, so the threshold
 * logic is testable without a database.
 */
export function clusterErrors(
  rows: { detail: Record<string, unknown> | null; agentId: string | null; eventId: string }[],
): ErrorCluster[] {
  const map = new Map<string, { count: number; agents: Set<string>; eventIds: string[]; sampleDetail: Record<string, unknown> }>()
  for (const r of rows) {
    const sig = errorSignature(r.detail)
    if (sig === null) continue
    let c = map.get(sig)
    if (!c) {
      c = { count: 0, agents: new Set(), eventIds: [], sampleDetail: r.detail ?? {} }
      map.set(sig, c)
    }
    c.count++
    if (r.agentId) c.agents.add(r.agentId)
    if (c.eventIds.length < MAX_EVIDENCE_EVENT_IDS) c.eventIds.push(r.eventId)
  }
  const clusters: ErrorCluster[] = []
  for (const [signature, c] of map) {
    if (c.agents.size >= PROPOSER_MIN_AGENTS || c.count >= PROPOSER_MIN_COUNT) {
      clusters.push({ signature, count: c.count, agents: c.agents.size, eventIds: c.eventIds, sampleDetail: c.sampleDetail })
    }
  }
  return clusters
}

/** First non-empty string among the candidates, else ''. */
function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim()
  return ''
}

/** First line of a string value, else ''. */
function firstLine(v: unknown): string {
  return typeof v === 'string' ? (v.split(/\r?\n/)[0] ?? '').trim() : ''
}

/** Draft a candidate pitfall proposal from an error cluster. The wording is an
 *  ARGUMENT a human can judge (hypothesis + disconfirming), not a bare edit. */
function draftFromCluster(cluster: ErrorCluster): ProposalDraft {
  const what = firstString(cluster.sampleDetail.code, cluster.sampleDetail.errorClass, firstLine(cluster.sampleDetail.message)) || 'a recurring error'
  const where = firstString(cluster.sampleDetail.area, cluster.sampleDetail.file)
  const title = where ? `Recurring failure: ${what} (${where})` : `Recurring failure: ${what}`
  const scope = `${cluster.count} time(s) across ${cluster.agents} agent(s)`
  return {
    target: 'knowledge',
    evidence: {
      signature: cluster.signature,
      eventIds: cluster.eventIds,
      count: cluster.count,
      agents: cluster.agents,
    },
    hypothesis: `This failure recurred (${scope}) in the last ${PROPOSER_WINDOW_DAYS} days, which suggests a durable pitfall worth recording so agents can avoid it.`,
    disconfirming: 'If this was a one-off environmental blip, or the underlying cause is already fixed, it is not a durable pitfall and should be rejected.',
    change: { title, body: `${what}${where ? ` in ${where}` : ''} recurred; record the cause and the avoidance once known.`, kind: 'pitfall' },
    triggerSignature: cluster.signature,
  }
}

/**
 * Run one proposer sweep tick.
 *
 * `opts.propose` is the core enqueue fn (injected). `opts.projectId` pins one project
 * (tests). `opts.now` is injected for tests; production uses the wall clock.
 */
export async function runProposerSweep(
  db: Db,
  opts: {
    propose: ProposeFn
    now?: Date
    limit?: number
    projectId?: string
    windowDays?: number
  },
): Promise<ProposerSweepResult> {
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? PROPOSER_WINDOW_DAYS
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
  const limit = opts.limit ?? PROPOSER_PROJECT_BATCH

  const projectIds = opts.projectId
    ? [opts.projectId]
    : await candidateProjects(db, since, limit)

  let processed = 0
  let proposals = 0
  for (const projectId of projectIds) {
    const created = await db.transaction(async (tx) => {
      // Single writer per project: skip if another worker holds it this tick. The
      // lock is transaction-scoped, releasing at the end of this block.
      const [{ locked }] = await tx.execute<{ locked: boolean }>(sql`
        select pg_try_advisory_xact_lock(${PROPOSER_LOCK_NAMESPACE}, hashtext(${projectId})) as locked
      `)
      if (!locked) return null
      return proposeForProject(tx, projectId, since, opts.propose)
    })
    if (created !== null) {
      processed++
      proposals += created
    }
  }
  return { projects: processed, proposals }
}

/** Projects worth scanning this tick: those with a recent error. Bounds the sweep to
 *  projects that could actually yield a proposal. */
async function candidateProjects(db: Db, since: Date, limit: number): Promise<string[]> {
  const withErrors = await db
    .selectDistinct({ id: events.projectId })
    .from(events)
    .where(and(eq(events.type, 'error'), gte(events.createdAt, since)))
  return withErrors.map(r => r.id).slice(0, limit)
}

/** Cluster a project's recent errors into candidate-pitfall proposals. Returns how
 *  many were actually created (idempotent no-ops do not count). Runs inside the
 *  caller's locked transaction, so it is the single writer for the project. */
async function proposeForProject(
  tx: DbOrTx,
  projectId: string,
  since: Date,
  propose: ProposeFn,
): Promise<number> {
  const errorRows = await tx
    .select({ detail: events.detail, agentId: events.agentId, eventId: events.id })
    .from(events)
    .where(and(
      eq(events.projectId, projectId),
      eq(events.type, 'error'),
      gte(events.createdAt, since),
    ))

  let created = 0
  for (const cluster of clusterErrors(errorRows)) {
    const row = await propose(tx, { projectId, ...draftFromCluster(cluster) })
    if (row) created++
  }
  return created
}
