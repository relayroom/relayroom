import { and, eq } from 'drizzle-orm'
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
 * Bump lastSeenAt for an EXISTING agent (reviving it if soft-deleted) and return
 * it. Does NOT create: agents are born only via the web UI (connectAgent), so an
 * activity path that targets an unregistered part must not conjure one - it
 * returns undefined and the caller rejects. Use for activity paths only.
 */
export async function touchAgent(db: Db, projectId: string, part: string) {
  const [agent] = await db.update(agents)
    .set({ lastSeenAt: new Date(), deletedAt: null })
    .where(and(eq(agents.projectId, projectId), eq(agents.part, part)))
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
