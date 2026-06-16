/**
 * (project, member) priority/human-lane capabilities (phase 06).
 *
 * A capability is a per-(project, member-principal) grant a manager hands out; an
 * agent cannot self-assert it. The member's stable principal is `agents.ownerUserId`
 * (= `ctx.userId` on the MCP connection), so capabilities ride the existing
 * `project_access` row (uniqueness on (projectId, userId)).
 *
 *  - 'urgent'      : may draw the SEPARATE urgent allowance (U) to wake idle parts.
 *  - 'needs_human' : may light the human notification bell (the 'needs-human' tag).
 */
import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '@relayroom/db'
import { projectAccess } from '@relayroom/db'

export type Capability = 'urgent' | 'needs_human'

/** The capability set for (project, member-principal). Empty set if no access row. */
export async function getCapabilities(
  db: DbOrTx,
  projectId: string,
  userId: string,
): Promise<Set<Capability>> {
  const [row] = await db
    .select({ caps: projectAccess.capabilities })
    .from(projectAccess)
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId)))
    .limit(1)
  return new Set((row?.caps ?? []) as Capability[])
}

export function hasCapability(caps: Set<Capability>, cap: Capability): boolean {
  return caps.has(cap)
}

/** Thrown when an agent explicitly requests a capability-gated action it lacks. */
export class CapabilityError extends Error {
  constructor(public readonly cap: Capability) {
    super(`missing capability: ${cap}`)
    this.name = 'CapabilityError'
  }
}

/**
 * Validate an `urgent` request. Policy decision (spec §7): urgent is an INTENTIONAL
 * wake request, so a missing capability is REJECTED with a clear error, never
 * silently downgraded to a normal send (which would hide the failure and risk the
 * "urgent message" getting buried in the normal lane). Not requesting urgent always
 * passes through as false regardless of capability.
 */
export function resolveUrgent(caps: Set<Capability>, requested: boolean | undefined): boolean {
  if (!requested) return false
  if (!caps.has('urgent')) throw new CapabilityError('urgent')
  return true
}
