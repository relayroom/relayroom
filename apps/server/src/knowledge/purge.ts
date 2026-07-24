/**
 * Purge knowledge derived from a thread (FEAT-0004 L3).
 *
 * A knowledge entry's `sourceRefs` is a provenance ledger, and it is an ARRAY: one
 * entry can cite several threads (a merged lesson). So purging thread A cannot be a
 * blanket delete of everything that mentions A.
 *
 *   - An entry whose ONLY source was A is deleted.
 *   - An entry citing A AND something else keeps existing, with A removed from its
 *     sourceRefs (detached).
 *
 * Deleting on any-match would lose knowledge another thread contributed; detaching
 * only (never deleting) would leave a sourceRef pointing at a purged thread, so the
 * provenance would lie. Doing both is the only option that leaves no reference to A
 * anywhere and loses no multi-source knowledge.
 *
 * Returns the two counts separately because the action is irreversible and the web
 * preview must say exactly "N deleted, M detached" - collapsing them would mislead
 * the person confirming. `dryRun` computes those counts and writes nothing, so the
 * preview and the delete are the SAME function and cannot diverge on what "derived
 * from thread X" means. The whole thing is one transaction: a partial purge would
 * leave some entries detached and some not, and a second attempt would report
 * different numbers.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { knowledge } from '@relayroom/db'

export interface PurgeResult {
  /** Entries whose sole source was this thread; removed entirely. */
  deleted: number
  /** Entries citing this thread and others; this thread stripped from sourceRefs. */
  detached: number
}

/**
 * Purge (or, with `dryRun`, count) knowledge derived from `threadId` in `projectId`.
 *
 * projectId is required and matched, so one project cannot purge another's
 * knowledge by naming its thread id.
 */
export async function purgeKnowledgeFromThread(
  db: Db,
  projectId: string,
  threadId: string,
  opts: { dryRun?: boolean } = {},
): Promise<PurgeResult> {
  // A dry run still runs in a transaction so its counts are a consistent snapshot,
  // but it writes nothing.
  return db.transaction(async (tx) => {
    // Every entry in this project that cites the thread. `@>` containment finds an
    // array element that includes {threadId}; the exact split (sole vs multi) is then
    // decided per row in JS, where the array semantics are clearest.
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
            .set({ sourceRefs: remaining, updatedAt: new Date() })
            .where(eq(knowledge.id, row.id))
        }
      }
    }
    return { deleted, detached }
  })
}
