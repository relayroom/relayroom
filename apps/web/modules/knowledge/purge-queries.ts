import { sql } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"
import { THREAD_SEARCH_LIMIT } from "@/modules/knowledge/purge-constants"

export interface PurgeableThread {
  threadId: string
  subject: string | null
  /** How many knowledge entries cite this thread. A rough size for the list only -
   *  the authoritative deleted/detached split comes from the purge dry-run. */
  entryCount: number
}

/**
 * Threads in a project that have knowledge distilled from them, newest first.
 *
 * This is the picker for the purge action: only threads that actually produced
 * knowledge are worth offering, and the owner chooses from their subjects rather
 * than pasting a thread id. The count here is just "how many entries cite this
 * thread" for the row; it deliberately does NOT try to pre-split deleted vs
 * detached - that split is the purge function's, and reproducing it here is
 * exactly the two-implementations drift we are avoiding. The real numbers arrive
 * from a dry-run when a thread is selected.
 */
export async function listPurgeableThreads(projectId: string): Promise<PurgeableThread[]> {
  // Unnest each entry's source_refs array, keep elements naming a thread, and
  // count distinct entries per thread. DISTINCT so an entry citing a thread twice
  // (two messages of it) counts once. Joined to thread for the subject and to
  // order by recency.
  const res = await db.execute(sql`
    SELECT ref->>'threadId' AS thread_id,
           t.subject           AS subject,
           count(DISTINCT k.id) AS n,
           max(t.updated_at)    AS last_activity
    FROM knowledge k
    CROSS JOIN LATERAL jsonb_array_elements(k.source_refs) AS ref
    LEFT JOIN thread t ON t.id = (ref->>'threadId')::uuid
    WHERE k.project_id = ${projectId}
      AND ref->>'threadId' IS NOT NULL
    GROUP BY ref->>'threadId', t.subject
    ORDER BY last_activity DESC NULLS LAST
  `)

  return ((res.rows ?? []) as Array<{ thread_id: string; subject: string | null; n: string | number }>).map(
    (r) => ({ threadId: r.thread_id, subject: r.subject, entryCount: Number(r.n) }),
  )
}

/**
 * Threads in a project matching a subject substring, newest first, INCLUDING
 * threads that no knowledge entry cites.
 *
 * This exists because `listPurgeableThreads` cannot reach the case the purge
 * remedy is for. That list starts from `knowledge` and expands source_refs, so a
 * thread whose knowledge was already purged has nothing to expand and never
 * appears - the operator who most needs to purge again is the one who cannot find
 * the thread. This query starts from `thread` instead and joins knowledge on, so
 * an entry count of zero is a result rather than an absence.
 *
 * Search by subject, not a pasted id: the owner in this situation knows what the
 * conversation was called, not its UUID, and purge does not delete threads, so the
 * subject is still there afterwards. Searching within a project also cannot name
 * another project's thread, which a paste box invites - though that is a bonus,
 * not the reason. The boundary is enforced where the purge happens, not here.
 */
export async function searchProjectThreads(projectId: string, query: string): Promise<PurgeableThread[]> {
  const q = query.trim()
  if (!q) return []

  // Count citing entries per thread with a correlated subquery rather than a join:
  // a thread with no knowledge must still produce a row, and the count must not be
  // multiplied by the source_refs expansion.
  const res = await db.execute(sql`
    SELECT t.id      AS thread_id,
           t.subject AS subject,
           (
             SELECT count(*)
             FROM knowledge k
             WHERE k.project_id = ${projectId}
               AND k.source_refs @> jsonb_build_array(jsonb_build_object('threadId', t.id::text))
           ) AS n
    FROM thread t
    WHERE t.project_id = ${projectId}
      AND t.subject ILIKE ${"%" + q + "%"}
    ORDER BY t.updated_at DESC NULLS LAST
    LIMIT ${THREAD_SEARCH_LIMIT}
  `)

  return ((res.rows ?? []) as Array<{ thread_id: string; subject: string | null; n: string | number }>).map(
    (r) => ({ threadId: r.thread_id, subject: r.subject, entryCount: Number(r.n) }),
  )
}
