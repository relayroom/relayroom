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
 * user can access. Scoped at the SQL level, so a user never sees content from
 * projects they cannot reach. Each category is capped; ordered most-recent first.
 */
export async function searchDashboard(
  userId: string,
  query: string,
): Promise<SearchResults> {
  const q = query.trim()
  if (q.length < 2) return EMPTY
  const like = likeArg(q)
  // The search scope must be the SAME notion of "projects this user can reach"
  // that requireProjectAccess (lib/auth-session.ts) enforces, or search silently
  // disagrees with the rest of the dashboard. Two rules there, both reproduced here:
  //
  //   1. an explicit project_access row grants access, and
  //   2. an org owner/admin counts as a project owner even with NO row, so that
  //      nobody who administers a project is locked out of it.
  //
  // Scoping on rule 1 alone meant an org admin who neither created the project nor
  // was granted a row could open and manage it in the UI while search returned
  // nothing for it. Either way a project-scope ban wins and removes the project.
  const scope = sql`(
    SELECT p.id FROM project p
    WHERE NOT EXISTS (
        SELECT 1 FROM project_access pa
        WHERE pa.project_id = p.id AND pa.user_id = ${userId} AND pa.banned_at IS NOT NULL
      )
      AND (
        EXISTS (
          SELECT 1 FROM project_access pa
          WHERE pa.project_id = p.id AND pa.user_id = ${userId}
        )
        OR EXISTS (
          SELECT 1 FROM better_auth_member m
          WHERE m.organization_id = p.organization_id
            AND m.user_id = ${userId}
            AND m.role IN ('owner', 'admin')
        )
      )
  )`

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
