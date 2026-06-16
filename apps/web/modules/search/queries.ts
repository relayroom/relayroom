import { sql } from "drizzle-orm"
import { db } from "@/modules/drizzle/db"

export interface ThreadHit {
  id: string
  subject: string
  status: string
  projectSlug: string
}
export interface EventHit {
  id: string
  type: string
  label: string | null
  projectSlug: string
}
export interface AgentHit {
  id: string
  part: string
  role: string
  projectSlug: string
}
export interface SearchResults {
  threads: ThreadHit[]
  events: EventHit[]
  agents: AgentHit[]
}

const EMPTY: SearchResults = { threads: [], events: [], agents: [] }
const LIMIT = 6

/** Escape ILIKE wildcards so user input is matched literally. */
function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Search threads (subject / message body / tags), events (type / note /
 * spawned label), and agents (part / nickname / badge) across the projects the
 * user can access (any project_access level = read-only or above). Scoped at the
 * SQL level, so a user never sees content from projects they are not a member
 * of. Each category is capped; ordered most-recent first.
 */
export async function searchDashboard(
  userId: string,
  query: string,
): Promise<SearchResults> {
  const q = query.trim()
  if (q.length < 2) return EMPTY
  const like = likeArg(q)
  // Projects the user has ACTIVE access to (the search scope). Exclude banned rows -
  // a banned member must not keep reading threads/messages/agents via search.
  const scope = sql`(SELECT project_id FROM project_access WHERE user_id = ${userId} AND banned_at IS NULL)`

  try {
    const [threadRes, eventRes, agentRes] = await Promise.all([
      db.execute(sql`
        SELECT t.id, t.subject, t.status, p.slug AS project_slug
        FROM thread t
        JOIN project p ON p.id = t.project_id
        WHERE t.project_id IN ${scope}
          AND (
            t.subject ILIKE ${like} ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id AND m.body ILIKE ${like} ESCAPE '\\')
            OR EXISTS (SELECT 1 FROM unnest(t.tags) tag WHERE tag ILIKE ${like} ESCAPE '\\')
          )
        ORDER BY t.updated_at DESC
        LIMIT ${LIMIT}
      `),
      db.execute(sql`
        SELECT e.id, e.type, e.detail->>'note' AS note, e.spawned_agent_label AS spawned, p.slug AS project_slug
        FROM event e
        JOIN project p ON p.id = e.project_id
        WHERE e.project_id IN ${scope}
          AND (
            e.type ILIKE ${like} ESCAPE '\\'
            OR e.detail->>'note' ILIKE ${like} ESCAPE '\\'
            OR e.spawned_agent_label ILIKE ${like} ESCAPE '\\'
          )
        ORDER BY e.created_at DESC
        LIMIT ${LIMIT}
      `),
      db.execute(sql`
        SELECT a.id, a.part, a.role, p.slug AS project_slug
        FROM agent a
        JOIN project p ON p.id = a.project_id
        WHERE a.project_id IN ${scope}
          AND (
            a.part ILIKE ${like} ESCAPE '\\'
            OR a.nickname ILIKE ${like} ESCAPE '\\'
            OR a.badge ILIKE ${like} ESCAPE '\\'
          )
        ORDER BY a.created_at DESC
        LIMIT ${LIMIT}
      `),
    ])

    const threads = ((threadRes.rows ?? []) as Array<{ id: string; subject: string; status: string; project_slug: string }>).map((r) => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      projectSlug: r.project_slug,
    }))
    const events = ((eventRes.rows ?? []) as Array<{ id: string; type: string; note: string | null; spawned: string | null; project_slug: string }>).map((r) => ({
      id: r.id,
      type: r.type,
      label: r.note ?? r.spawned ?? null,
      projectSlug: r.project_slug,
    }))
    const agents = ((agentRes.rows ?? []) as Array<{ id: string; part: string; role: string; project_slug: string }>).map((r) => ({
      id: r.id,
      part: r.part,
      role: r.role,
      projectSlug: r.project_slug,
    }))

    return { threads, events, agents }
  } catch (err) {
    console.error("[searchDashboard]", err)
    return EMPTY
  }
}
