/**
 * The OAuth client id RelayRoom issues its own agent tokens under.
 *
 * This lives in shared because TWO packages have to agree on it and they are not
 * the same package: apps/web MINTS agent tokens under this client id (connectAgent),
 * and apps/server ENFORCES the `project:<id>` scope those tokens carry, keying off
 * exactly this value to tell them apart from standard OAuth tokens.
 *
 * If the issuer and the enforcer ever disagree on the string, the enforcer stops
 * recognising agent tokens, classifies them as standard user-scoped OAuth, and
 * waves them all through - a security gate that turns itself off with every test
 * still green, because each side mints and checks with its own copy. One home is
 * the only thing that actually prevents that.
 */
export const INTERNAL_AGENT_CLIENT_ID = 'relayroom-internal-agent-client'

/** The scope an agent token carries to name the single project it may act on. */
export function projectScope(projectId: string): string {
  return `project:${projectId}`
}
