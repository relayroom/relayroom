import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from './client'
import { agents, projects } from './schema'

// ── Project helpers ───────────────────────────────────────────────────────────

/** Look up a project by (organizationId, slug). Returns undefined if not found. */
export async function getProjectBySlug(db: Db, organizationId: string, slug: string) {
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.slug, slug)))
  return project
}

/** Create a project. Caller must supply organizationId; no auto-workspace logic. */
export async function createProject(
  db: Db,
  params: { organizationId: string; slug: string; name: string; createdByUserId?: string },
) {
  const [project] = await db.insert(projects)
    .values({
      organizationId: params.organizationId,
      slug: params.slug,
      name: params.name,
      createdByUserId: params.createdByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning()
  if (project) return project
  // Race: another caller won the insert; re-select.
  return getProjectBySlug(db, params.organizationId, params.slug)
}

// ── Agent helpers ─────────────────────────────────────────────────────────────

export async function getOrCreateAgent(db: Db, projectId: string, part: string) {
  const [agent] = await db.insert(agents)
    .values({ projectId, part })
    .onConflictDoNothing()
    .returning()
  if (agent) return agent
  // Race lost or already existed: re-select.
  const [winner] = await db.select().from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.part, part)))
  return winner
}

/**
 * Bump lastSeenAt for an EXISTING, LIVE agent and return it. Does NOT create and
 * does NOT revive: agents are born and re-added only via the web UI (connectAgent),
 * so an activity path that targets an unregistered - or removed - part must not
 * conjure or resurrect one. It returns undefined and the caller rejects.
 *
 * This used to also set `deletedAt: null`, which made a delete undoable by
 * accident rather than by intent: the deleted part's pager is still running on the
 * agent machine, and its next heartbeat (seconds later) brought the row back, put
 * it back in the roster, and made it a wake recipient again - while the person who
 * deleted it believed it was gone. computeRecipients, the eligibility sweep, and
 * roster all filter `deletedAt`, so activity was the one path that undid a removal.
 *
 * Deliberate re-add still works and is unaffected: connectAgent upserts with
 * `deletedAt: null` when a part is added again from the dashboard. Intent revives;
 * traffic does not.
 */
export async function touchAgent(db: Db, projectId: string, part: string) {
  const [agent] = await db.update(agents)
    .set({ lastSeenAt: new Date() })
    .where(and(
      eq(agents.projectId, projectId),
      eq(agents.part, part),
      isNull(agents.deletedAt),
    ))
    .returning()
  return agent
}

// ── Legacy compat: server routes use getOrCreateProject(db, slug) ─────────────
// Routes pass a plain slug string (no organizationId) during the pre-auth phase.
// We use a sentinel organization_id so the unique(org, slug) constraint still works.
// This will be replaced in F5 when proper auth is in place.

export const ANON_ORG_ID = '00000000-0000-0000-0000-000000000000'

export async function getOrCreateProject(db: Db, slug: string) {
  const [existing] = await db.select().from(projects)
    .where(and(eq(projects.organizationId, ANON_ORG_ID), eq(projects.slug, slug)))
  if (existing) return existing
  const [created] = await db.insert(projects)
    .values({ organizationId: ANON_ORG_ID, slug, name: slug })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const [winner] = await db.select().from(projects)
    .where(and(eq(projects.organizationId, ANON_ORG_ID), eq(projects.slug, slug)))
  return winner
}
