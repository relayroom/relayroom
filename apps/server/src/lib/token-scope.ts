/**
 * Does an access token's scope permit acting on a given project?
 *
 * connectAgent issues agent tokens with `scopes: "project:<id>"`, but nothing
 * checked it. The MCP boundary resolved the project from the connect code and
 * authorized on org membership alone, so a token minted for project A
 * authenticated fine against project B in the same org - the scope on the token
 * was decoration. (BUG-0007, shipped in 0.4.1.)
 *
 * TWO ISSUERS write to better_auth_oauth_access_token, and the difference is the
 * whole reason this is a predicate rather than a one-line check:
 *
 *   internal (connectAgent)  client_id = INTERNAL_AGENT_CLIENT_ID
 *                            scopes    = "project:<id>"          -> enforce
 *   standard OAuth           any other client_id
 *                            scopes    = "openid profile ..."    -> do not enforce
 *
 * A standard MCP authorization-code token is user-scoped by design and carries no
 * project scope at all. Enforcing "must contain project:<id>" on everything would
 * reject every one of them - which is why this refuses to guess from the shape of
 * the scope string and keys off the issuer instead.
 *
 * Every enforcement point (MCP connect, SSE, the backfill migration) calls THIS
 * function. Three places re-deriving the same rule is how they drift apart.
 */

// The client id comes from @relayroom/shared so the issuer (web's connectAgent)
// and this enforcer read one value. Two copies would let the gate switch itself
// off silently: a changed string here makes every agent token look like a
// standard OAuth token, which this function waves through.
export { INTERNAL_AGENT_CLIENT_ID } from '@relayroom/shared'
import { INTERNAL_AGENT_CLIENT_ID, projectScope } from '@relayroom/shared'

/**
 * True when a token bearing (clientId, scopes) may act on `projectId`.
 *
 * The scope string is space-delimited and matched by EXACT ELEMENT. A prefix test
 * would accept `project:<A>` for a project whose id merely starts with A's id, and
 * `project:<A>-something` for A - both are attacker-shaped inputs, since the
 * caller picks the project by supplying a connect code.
 */
export function tokenScopeAllowsProject(
  clientId: string | null,
  scopes: string | null,
  projectId: string,
): boolean {
  // Not an agent token: user-scoped by design, nothing to enforce here.
  if (clientId !== INTERNAL_AGENT_CLIENT_ID) return true

  // An internal token with no scope recorded cannot be shown to permit anything.
  // Absent, empty, and whitespace-only all land here and are refused - a missing
  // scope must not read as an unrestricted one.
  // projectScope() is the same helper the issuer uses to build the string, so the
  // two cannot disagree on the format either.
  const granted = (scopes ?? '').split(' ').filter(Boolean)
  return granted.includes(projectScope(projectId))
}
