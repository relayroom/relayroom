import { sql } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"

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
