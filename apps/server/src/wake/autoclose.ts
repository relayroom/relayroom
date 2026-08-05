/**
 * Idle-thread auto-close (backstop).
 *
 * Agents are told to `close` a thread when they are done, but they forget. An open
 * thread keeps its participants wakeable, so a forgotten thread is a slow token
 * leak. This job closes any still-active thread whose most recent message (or, if
 * it has none, its creation) is older than the idle window. Idempotent and cheap.
 */
import { and, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { markProjectKnowledgeDirty, messageRecipients, messages, threads } from '@relayroom/db'

/** A thread with no activity for this long is auto-closed. */
export const THREAD_IDLE_CLOSE_MS = 30 * 60_000 // 30 min

/** Statuses that are still "live" and therefore eligible for auto-close. */
const ACTIVE_STATUSES = ['open', 'answered', 'holding'] as const

export async function autoCloseIdleThreads(
  db: Db,
  idleMs: number = THREAD_IDLE_CLOSE_MS,
): Promise<number> {
  // Close active threads whose newest message is older than the idle window (coalesce
  // to the thread's own createdAt when it has no messages yet) in ONE atomic UPDATE
  // that RE-EVALUATES the idle condition. A separate select-then-update raced: a new
  // message arriving between the select and the close would be closed-and-marked-read
  // anyway -> the recipient never sees it (lost MESSAGE, not just a lost wake).
  // Re-checking inside the UPDATE means a thread that got a message in that window is
  // no longer idle and is left open. The cutoff is computed in SQL via make_interval
  // (binding a JS Date inside a raw sql fragment mis-serializes with postgres-js).
  // Close, mark, and clear unread in ONE transaction. The marker is written here for the
  // same reason the close tool writes it, and with the same caveat: NOTHING READS IT
  // TODAY. It was the extractor sweep's trigger and the sweep was removed in 0.6.3; it is
  // kept because a cross-thread reflection pass needs exactly this timestamp, and dropping
  // a column to re-add it is worse than writing one nobody reads yet. Do not read these
  // writes as evidence that something consumes them. markProjectKnowledgeDirty is the
  // single cross-package setter (@relayroom/db).
  return db.transaction(async (tx) => {
    const closed = await tx
      .update(threads)
      .set({ status: 'closed' })
      .where(
        and(
          inArray(threads.status, ACTIVE_STATUSES as unknown as string[]),
          sql`coalesce(
            (select max(m.created_at) from ${messages} m where m.thread_id = ${threads.id}),
            ${threads.createdAt}
          ) < now() - make_interval(secs => ${idleMs / 1000})`,
        ),
      )
      .returning({ id: threads.id })

    if (closed.length === 0) return 0
    const ids = closed.map(r => r.id)
    // Every project that owns a just-closed thread has knowledge that moved. Distinct
    // projects only. (No consumer today - see the transaction comment above.)
    const dirtied = await tx.selectDistinct({ projectId: threads.projectId })
      .from(threads).where(inArray(threads.id, ids))
    for (const { projectId } of dirtied) await markProjectKnowledgeDirty(tx, projectId)
    // Clear unread ONLY on threads we actually closed, so no wake path (pending-wake
    // counts raw unread) keeps waking a participant for a resolved conversation.
    await tx.update(messageRecipients).set({ readAt: new Date() }).where(and(
      isNull(messageRecipients.readAt),
      inArray(
        messageRecipients.messageId,
        tx.select({ id: messages.id }).from(messages).where(inArray(messages.threadId, ids)),
      ),
    ))
    return closed.length
  })
}
