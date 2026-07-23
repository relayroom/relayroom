import type { HubBusEvent } from "@relayroom/shared"
import { and, eq } from "drizzle-orm"
import { getServerSession, isOrgMember, isBannedFromProject } from "@/lib/auth-session"
import { db } from "@/modules/drizzle/db"
import { projects, projectAccess } from "@relayroom/db/schema"
import { better_auth_member } from "@relayroom/db/auth-schema"
import { subscribe } from "@/lib/realtime/listener"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const HEARTBEAT_MS = 15000

/**
 * How often the open stream re-checks that the viewer is still allowed to read it.
 *
 * The connect-time check below only decides who may OPEN a stream. An SSE stream
 * has no natural end, so without this a member who is banned (or removed from the
 * org) while a dashboard tab is open keeps receiving that project's bus - thread
 * subjects, senders, pager liveness - until they happen to close the tab. That
 * makes revocation depend on the viewer's browsing habits.
 *
 * Kept coarser than the heartbeat so revocation costs two cheap queries a minute
 * per stream rather than four, which is well inside the "how fast must a ban take
 * effect" bar while staying far off the hot path.
 */
const REAUTH_MS = 30000

/**
 * Server-Sent Events stream of a project's live agent activity.
 *
 * SECURITY: the viewer must have a session AND be a member of the project's
 * org. Events are filtered server-side by the authoritative `projectId` (slugs
 * are not unique across orgs), so one tenant can never observe another's bus.
 * Authorization is re-checked periodically for the life of the stream, not only
 * at connect time - see REAUTH_MS.
 */
export async function GET(req: Request) {
  const session = await getServerSession()
  if (!session) return new Response("unauthorized", { status: 401 })

  const projectId = new URL(req.url).searchParams.get("projectId")
  if (!projectId) return new Response("projectId required", { status: 400 })

  const [project] = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) return new Response("not found", { status: 404 })
  if (!(await isOrgMember(project.organizationId))) {
    return new Response("forbidden", { status: 403 })
  }
  // Ban gate: a member banned from this project must not receive its live event
  // stream (subjects, senders, pager liveness). Mirror of the agent-bus ban gate.
  if (await isBannedFromProject(project.id, session.user.id)) {
    return new Response("forbidden", { status: 403 })
  }

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reauth: ReturnType<typeof setInterval> | undefined

  /**
   * Re-run the org-membership and project-ban checks for an already-open stream.
   *
   * Deliberately queries the DB directly instead of reusing isOrgMember /
   * isBannedFromProject: those are wrapped in React `cache()`, which memoizes for
   * the lifetime of ONE request. An SSE stream is a single request that never
   * ends, so the cached helpers would replay the connect-time answer forever and
   * this re-check would silently do nothing. They also resolve the caller from
   * `headers()`, which is not available once the response has begun streaming -
   * hence passing the already-resolved userId in.
   */
  const stillAuthorized = async (): Promise<boolean> => {
    try {
      const [[member], [access]] = await Promise.all([
        db
          .select({ id: better_auth_member.id })
          .from(better_auth_member)
          .where(
            and(
              eq(better_auth_member.organizationId, project.organizationId),
              eq(better_auth_member.userId, session.user.id),
            ),
          )
          .limit(1),
        db
          .select({ bannedAt: projectAccess.bannedAt })
          .from(projectAccess)
          .where(
            and(
              eq(projectAccess.projectId, project.id),
              eq(projectAccess.userId, session.user.id),
            ),
          )
          .limit(1),
      ])
      return !!member && access?.bannedAt == null
    } catch (err) {
      // A transient DB error must not revoke a legitimate viewer's stream; the
      // next tick re-checks. Failing open here is the same call the connect-time
      // path makes by letting an error surface as a 500 rather than a 403.
      console.error("[realtime] re-authorization check failed", err)
      return true
    }
  }

  // Idempotent teardown: drop the bus subscription and stop the timers.
  // Called from both ReadableStream.cancel() and req.signal abort, so whichever
  // fires first cleans up and the other is a no-op. Without this, a client
  // disconnect that does not trigger cancel() would leak the emitter listener
  // (and a 15s interval) for the process lifetime — a real prod leak.
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    unsubscribe?.()
    if (heartbeat) clearInterval(heartbeat)
    if (reauth) clearInterval(reauth)
  }

  if (req.signal.aborted) cleanup()
  req.signal.addEventListener("abort", cleanup)

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // controller already closed — ignore
        }
      }

      // Open the connection immediately so the browser's EventSource resolves.
      safeEnqueue(": connected\n\n")

      // If the request already aborted (cleanup() ran before start), do NOT create a
      // subscription + heartbeat - cleanup is idempotent and would never fire again,
      // leaking the listener + 15s interval for the process lifetime.
      if (cleaned) { try { controller.close() } catch { /* already closed */ } return }

      const unsub = subscribe((event: HubBusEvent) => {
        if (event.projectId !== projectId) return
        safeEnqueue(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
      })
      const hb = setInterval(() => safeEnqueue(": ping\n\n"), HEARTBEAT_MS)
      // Revocation while the tab stays open: stop feeding the stream and close it
      // the moment the viewer loses org membership or is banned from the project.
      const ra = setInterval(async () => {
        if (cleaned) return
        if (await stillAuthorized()) return
        cleanup()
        try { controller.close() } catch { /* already closed */ }
      }, REAUTH_MS)
      unsubscribe = unsub
      heartbeat = hb
      reauth = ra

      // Abort can also fire DURING setup (after the guard, before we stored the
      // handles): cleanup() then saw undefined and was a no-op, so tear down here.
      if (cleaned) { unsub(); clearInterval(hb); clearInterval(ra) }
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
