/**
 * How long after its last beat a pager still counts as online.
 *
 * Two places decide this and they are on opposite sides of the server/client
 * boundary: modules/agent/queries.ts stamps `pagerOnline` on server-rendered
 * rows, and components/realtime/realtime-provider.tsx ages out live entries in
 * the browser as pager events arrive. They have to agree, or the dot the server
 * painted and the dot the client repaints disagree and the indicator flickers
 * between renders.
 *
 * They could not simply import from each other: modules/agent/queries.ts pulls
 * in the db client, so a client component importing the constant from there
 * would drag server code into the browser bundle. Hence a module with no
 * dependencies at all, which either side can import.
 */

/** The pager beats every ~30s; treat it as online within 3 missed beats. */
export const PAGER_ONLINE_WINDOW_MS = 90_000

/** Whether a pager is alive, given the last beat we know about. */
export function isPagerOnline(pagerLastSeenAt: Date | null | undefined): boolean {
  if (!pagerLastSeenAt) return false
  return Date.now() - pagerLastSeenAt.getTime() < PAGER_ONLINE_WINDOW_MS
}
