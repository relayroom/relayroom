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
 * Candidate garbage collection is NOT here. It needs a retention policy
 * (`knowledgeConfig.retentionDays`) that does not arrive until L3, and a sweep with
 * no threshold to apply is a code path that cannot run and therefore cannot be
 * trusted when it finally does.
 */
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { knowledge, knowledgeAudits } from '@relayroom/db'

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
