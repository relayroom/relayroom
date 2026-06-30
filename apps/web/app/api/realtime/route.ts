import type { HubBusEvent } from "@relayroom/shared"
import { eq } from "drizzle-orm"
import { getServerSession, isOrgMember, isBannedFromProject } from "@/lib/auth-session"
import { db } from "@/modules/drizzle/db"
import { projects } from "@relayroom/db/schema"
import { subscribe } from "@/lib/realtime/listener"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const HEARTBEAT_MS = 15000

/**
 * Server-Sent Events stream of a project's live agent activity.
 *
 * SECURITY: the viewer must have a session AND be a member of the project's
 * org. Events are filtered server-side by the authoritative `projectId` (slugs
 * are not unique across orgs), so one tenant can never observe another's bus.
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

  // Idempotent teardown: drop the bus subscription and stop the heartbeat.
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
      unsubscribe = unsub
      heartbeat = hb

      // Abort can also fire DURING setup (after the guard, before we stored the
      // handles): cleanup() then saw undefined and was a no-op, so tear down here.
      if (cleaned) { unsub(); clearInterval(hb) }
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
