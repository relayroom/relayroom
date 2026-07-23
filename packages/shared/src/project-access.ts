// Type-only, so nothing here participates in a module cycle with the barrel and
// nothing here pulls in zod at runtime: this file must stay importable from a
// plain Node process with no framework around it.
import type { ProjectAccessLevel } from './index'

/**
 * Who may do what in a project, as a pure decision.
 *
 * The dashboard already had this logic, but it lived inside a Next-bound helper
 * (`requireProjectAccess`) that resolves translations and imports the web app's own
 * db handle. The MCP server cannot import any of that, so it had no way to ask the
 * same question - which is how a project-level gate ended up being impossible to add
 * on the server side at all.
 *
 * So the rule lives here and takes facts, not a database. Callers do their own
 * lookup (they already have one) and attach their own failure text: the dashboard
 * turns a reason into a translated toast, the server turns it into a status code.
 * Nothing in this file can pull in a request context, which is the property that
 * makes it usable from both.
 */

/**
 * Higher = more authority. The ordering is the whole point of the type, and the
 * key set doubles as the runtime domain (a test holds it to `projectAccessLevel`).
 */
export const PROJECT_ACCESS_RANK: Record<ProjectAccessLevel, number> = {
  readonly: 0,
  write: 1,
  owner: 2,
}

/** Org roles that are treated as project owners without an explicit grant. */
const ORG_MANAGER_ROLES = new Set(['owner', 'admin'])

/**
 * True for an org role that administers every project in the org. Without this an
 * org owner is locked out of a project simply because nobody remembered to grant
 * them a `project_access` row in it.
 */
export function isOrgManager(orgRole: string | null | undefined): boolean {
  return typeof orgRole === 'string' && ORG_MANAGER_ROLES.has(orgRole)
}

/** What the caller looked up. Every field is "as stored", including absent. */
export interface ProjectAccessFacts {
  /** `better_auth_member.role` in the PROJECT's org. null/undefined = not a member. */
  orgRole?: string | null
  /** `project_access.bannedAt`. Any non-null value means banned. */
  bannedAt?: Date | string | null
  /** `project_access.level`. null/undefined = no grant row. */
  grantLevel?: string | null
}

export type ProjectAccessDenial =
  /** Not a member of the organization that owns the project. */
  | 'not_org_member'
  /** Banned from this project; authority is revoked regardless of role or grant. */
  | 'banned'
  /** No project_access row, and not an org manager. */
  | 'no_grant'
  /** Has a grant, but below the level this action needs. */
  | 'insufficient_level'

export type ProjectAccessDecision =
  | { ok: true; level: ProjectAccessLevel }
  | { ok: false; reason: ProjectAccessDenial; level?: ProjectAccessLevel }

/**
 * The level a user effectively holds, or null when they hold none. An org manager
 * is an owner everywhere in the org; anyone else has exactly their granted level.
 * A level outside the enum is treated as no grant rather than trusted blindly -
 * that column is plain text, and an unknown value is not evidence of authority.
 */
export function effectiveProjectLevel(facts: ProjectAccessFacts): ProjectAccessLevel | null {
  if (isOrgManager(facts.orgRole)) return 'owner'
  const granted = facts.grantLevel
  if (typeof granted !== 'string' || !(granted in PROJECT_ACCESS_RANK)) return null
  return granted as ProjectAccessLevel
}

/** Whether `level` satisfies a minimum. Exported because rank order is the contract. */
export function meetsProjectAccess(level: ProjectAccessLevel, minLevel: ProjectAccessLevel): boolean {
  return PROJECT_ACCESS_RANK[level] >= PROJECT_ACCESS_RANK[minLevel]
}

/**
 * The decision itself. Order matters and is deliberate: a ban outranks every role,
 * so a banned org owner is denied rather than promoted to owner by the next rule.
 */
export function decideProjectAccess(
  facts: ProjectAccessFacts,
  minLevel: ProjectAccessLevel,
): ProjectAccessDecision {
  if (!facts.orgRole) return { ok: false, reason: 'not_org_member' }
  if (facts.bannedAt != null) return { ok: false, reason: 'banned' }

  const level = effectiveProjectLevel(facts)
  if (!level) return { ok: false, reason: 'no_grant' }
  if (!meetsProjectAccess(level, minLevel)) return { ok: false, reason: 'insufficient_level', level }

  return { ok: true, level }
}
