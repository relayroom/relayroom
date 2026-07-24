/**
 * Expiry sweep for knowledge entries (FEAT-0001 L0).
 *
 * An entry with `expiresAt` in the past is one somebody decided should stop being
 * said. This retires those rows and writes the audit line for each, so a state
 * change nobody typed still has a record saying what changed and why.
 *
 * NOT the enforcement path. `recall` filters `expires_at` itself, so an expired
 * entry is already invisible the moment it expires, whether or not this has run.
 * That is deliberate: enforcement that depends on a timer is enforcement that is
 * wrong for as long as the timer is late. This sweep is bookkeeping - it settles
 * the stored state and the ledger to match what readers already see - which is why
 * it can run on a relaxed interval.
 *
 * Candidate garbage collection and the retired hard-delete are the L3 additions
 * below (runKnowledgeGarbageCollection): they need `knowledgeConfig.retentionDays`,
 * which L3 introduces. They live in this same module because "how a knowledge entry
 * ages out" is one concern, whether the trigger is an explicit expiry or a
 * retention policy.
 */
import { and, eq, isNotNull, lt, lte, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { knowledge, knowledgeAudits, knowledgeValidations, projects } from '@relayroom/db'

/** Max entries retired per tick, instance-wide. */
export const RETENTION_BATCH = 200

/**
 * Entries one project may take from a single batch. Same reasoning as the wake
 * sweep (BUG-0008): the batch is instance-wide, so without a per-project ceiling
 * one project with a large expiry backlog takes every slot and another project's
 * expired entries are never retired at all. Rounded up so an uneven split does not
 * leave the batch short.
 */
export const RETENTION_PER_PROJECT_FLOOR = 20

export interface RetentionResult {
  /** Entries moved to `retired` this tick. */
  retired: number
}

/**
 * Retire every entry whose `expiresAt` has passed, oldest expiry first.
 *
 * `candidate` and `trusted` are the states worth retiring: `contradicted` and
 * `retired` are already terminal, and moving them would write audit rows that
 * record nothing.
 */
export async function runKnowledgeRetention(
  db: Db,
  opts: { limit?: number; projectId?: string } = {},
): Promise<RetentionResult> {
  const limit = opts.limit ?? RETENTION_BATCH

  const due = await db
    .select({
      id: knowledge.id,
      projectId: knowledge.projectId,
      state: knowledge.validationState,
      expiresAt: knowledge.expiresAt,
    })
    .from(knowledge)
    .where(and(
      isNotNull(knowledge.expiresAt),
      lte(knowledge.expiresAt, new Date()),
      sql`${knowledge.validationState} in ('candidate','trusted')`,
      ...(opts.projectId ? [eq(knowledge.projectId, opts.projectId)] : []),
    ))
    .orderBy(knowledge.expiresAt, knowledge.id)

  // Per-project ceiling applied in code rather than SQL: the candidate set here is
  // "entries already past their expiry", which is small and bounded by how many
  // expiries were actually set - not by how many agents exist. A window function
  // would cost more to read than it saves.
  const perProject = Math.max(
    RETENTION_PER_PROJECT_FLOOR,
    Math.ceil(limit / Math.max(1, new Set(due.map(r => r.projectId)).size)),
  )
  const taken = new Map<string, number>()
  const batch: typeof due = []
  for (const row of due) {
    if (batch.length >= limit) break
    const n = taken.get(row.projectId) ?? 0
    if (n >= perProject) continue
    taken.set(row.projectId, n + 1)
    batch.push(row)
  }

  let retired = 0
  for (const row of batch) {
    // One transaction per entry, and the UPDATE re-checks the state it expects.
    // A promotion landing between the read above and this write would otherwise be
    // silently overwritten by a decision made from stale data.
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(knowledge)
        .set({ validationState: 'retired', updatedAt: new Date() })
        .where(and(
          eq(knowledge.id, row.id),
          eq(knowledge.validationState, row.state),
        ))
        .returning({ id: knowledge.id })
      if (updated.length === 0) return false

      await tx.insert(knowledgeAudits).values({
        projectId: row.projectId,
        action: 'retire',
        knowledgeId: row.id,
        fromState: row.state,
        toState: 'retired',
        actorKind: 'system',
        detail: { reason: 'expired', expiresAt: row.expiresAt?.toISOString() ?? null },
      })
      return true
    })
    if (changed) retired++
  }

  return { retired }
}

// ── L3: retention-policy garbage collection ───────────────────────────────────

export interface GarbageCollectionResult {
  /** candidate entries retired for aging out with no support. */
  retired: number
  /** retired entries hard-deleted past retentionDays * 2. */
  deleted: number
}

/**
 * Apply each project's `knowledgeConfig.retentionDays`:
 *   - a CANDIDATE older than retentionDays with NO supporting validation is retired
 *     (an unpromoted guess that nobody ever backed - it has had its chance);
 *   - a RETIRED entry older than retentionDays * 2 is hard-deleted (the grace after
 *     retirement before the row itself is removed).
 *
 * Only projects that actually set retentionDays are touched: with no policy there is
 * no threshold, and a GC with no threshold must do nothing rather than invent one.
 * "Older than" is measured from updatedAt for the retired hard-delete (when it became
 * retired) and createdAt for the candidate retire (when the guess was made).
 *
 * A candidate WITH a support validation is spared even when old: something backed it,
 * so it is a live claim awaiting a second issuer, not an abandoned one.
 *
 * Per-project cap, same BUG-0008 reasoning as the expiry sweep above.
 */
export async function runKnowledgeGarbageCollection(
  db: Db,
  opts: { now?: Date; limit?: number; projectId?: string } = {},
): Promise<GarbageCollectionResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? RETENTION_BATCH

  // Projects with a retention policy, and the policy value. `knowledge_config` is
  // jsonb; the ->> extracts retentionDays as text, cast to int.
  const configured = await db
    .select({
      id: projects.id,
      retentionDays: sql<number | null>`(${projects.knowledgeConfig} ->> 'retentionDays')::int`,
    })
    .from(projects)
    .where(and(
      sql`(${projects.knowledgeConfig} ->> 'retentionDays') is not null`,
      ...(opts.projectId ? [eq(projects.id, opts.projectId)] : []),
    ))

  let retired = 0
  let deleted = 0
  for (const project of configured) {
    const days = project.retentionDays
    if (!days || days <= 0) continue
    const retireCutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const deleteCutoff = new Date(now.getTime() - days * 2 * 24 * 60 * 60 * 1000)

    // Candidates old enough, with no supporting validation, capped per project.
    const staleCandidates = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(
        eq(knowledge.projectId, project.id),
        eq(knowledge.validationState, 'candidate'),
        lt(knowledge.createdAt, retireCutoff),
        sql`not exists (
          select 1 from ${knowledgeValidations} v
          where v.knowledge_id = ${knowledge.id} and v.signal = 'support'
        )`,
      ))
      .orderBy(knowledge.createdAt, knowledge.id)
      .limit(Math.ceil(limit / Math.max(1, configured.length)))

    for (const c of staleCandidates) {
      const changed = await db.transaction(async (tx) => {
        const updated = await tx
          .update(knowledge)
          .set({ validationState: 'retired', updatedAt: new Date() })
          .where(and(eq(knowledge.id, c.id), eq(knowledge.validationState, 'candidate')))
          .returning({ id: knowledge.id })
        if (updated.length === 0) return false
        await tx.insert(knowledgeAudits).values({
          projectId: project.id,
          action: 'retire',
          knowledgeId: c.id,
          fromState: 'candidate',
          toState: 'retired',
          actorKind: 'system',
          detail: { reason: 'retention_gc', retentionDays: days },
        })
        return true
      })
      if (changed) retired++
    }

    // Retired entries past retentionDays * 2: hard delete. No audit knowledgeId to
    // keep (the row is going), so the audit records the id in detail instead - the
    // ledger should still show a deletion happened.
    const toDelete = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(
        eq(knowledge.projectId, project.id),
        eq(knowledge.validationState, 'retired'),
        lt(knowledge.updatedAt, deleteCutoff),
      ))
      .orderBy(knowledge.updatedAt, knowledge.id)
      .limit(Math.ceil(limit / Math.max(1, configured.length)))

    for (const d of toDelete) {
      await db.transaction(async (tx) => {
        await tx.insert(knowledgeAudits).values({
          projectId: project.id,
          action: 'retire',
          knowledgeId: null, // the row is about to be gone; keep the id in detail
          fromState: 'retired',
          toState: 'retired',
          actorKind: 'system',
          detail: { reason: 'retention_hard_delete', knowledgeId: d.id, retentionDays: days },
        })
        await tx.delete(knowledge).where(eq(knowledge.id, d.id))
      })
      deleted++
    }
  }

  return { retired, deleted }
}
