import type { HubBusEvent } from '@relayroom/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { projects } from '@relayroom/db'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Bus } from '../bus'
import { getAgentTokenContext, tryAttachTokenContext } from '../auth'

export function createSseRoute(db: Db, bus: Bus) {
  const route = new Hono()

  route.get('/', async c => {
    const queryProject = c.req.query('project')
    const queryCode = c.req.query('code')
    const queryPart = c.req.query('part')
    // Opportunistically attach token context if a valid bearer token is present.
    await tryAttachTokenContext(db, c)
    const ctx = getAgentTokenContext(c)

    // Tenant-safe delivery filter. We ALWAYS filter by the AUTHORITATIVE projectId
    // (slugs are only unique within an org, so two orgs can share a slug — filtering
    // by slug would leak another tenant's events). A caller must therefore prove a
    // project via one of two unambiguous keys; the legacy slug-only fallback is gone.
    // Resolution priority:
    //   1. token ctx (authenticated) -> token's projectId
    //   2. ?code=<connect_code> (globally unique) -> resolve to projectId
    let matches: (event: HubBusEvent) => boolean
    if (ctx) {
      // Authenticated: subscribe only to the token's project/part; reject mismatch.
      if (queryProject !== undefined && queryProject !== ctx.projectSlug) {
        return c.json({ error: `token is scoped to project '${ctx.projectSlug}'` }, 403)
      }
      if (queryPart !== undefined && queryPart !== ctx.agentPart) {
        return c.json({ error: `token is scoped to part '${ctx.agentPart}'` }, 403)
      }
      const { projectId, agentPart } = ctx
      matches = event => event.projectId === projectId && event.part === agentPart
    }
    else if (queryCode) {
      // connect_code is globally unique -> the unambiguous agent-facing project
      // key (same one used for `claude mcp add` and the MCP resource URL).
      const [proj] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.connectCode, queryCode))
        .limit(1)
      if (!proj) return c.json({ error: 'unknown connect code' }, 404)
      const projectId = proj.id
      const part = queryPart
      matches = event => event.projectId === projectId && (!part || event.part === part)
    }
    else {
      // No token and no connect code -> cannot scope to a tenant-safe project.
      return c.json({ error: 'agent token or connect code required' }, 401)
    }

    // Tell reverse proxies (nginx, Nginx Proxy Manager, ...) NOT to buffer this
    // response. SSE must stream; a buffering proxy holds the bytes and the agent
    // never receives wakes (the inbox fills but nothing wakes up). Hono's streamSSE
    // already sets Content-Type/Cache-Control; X-Accel-Buffering is the proxy hint
    // that nginx-family proxies honor to disable buffering per-response.
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async stream => {
      let live = true
      const teardown = () => {
        if (!live) return
        live = false
        bus.off('message', onMessage)
      }
      const onMessage = (event: HubBusEvent) => {
        if (!live || !matches(event)) return
        // A write to a disconnected client rejects; without a .catch() that is an
        // unhandled rejection AND the listener stays registered (leak). Treat any
        // write failure as a disconnect: tear down so we stop pushing to a dead stream.
        stream.writeSSE({ event: 'message', data: JSON.stringify(event) }).catch(teardown)
      }
      bus.on('message', onMessage)
      stream.onAbort(teardown)
      while (live) {
        await stream.sleep(15000)
        if (live) await stream.writeSSE({ event: 'ping', data: 'keepalive' }).catch(teardown)
      }
    })
  })

  return route
}
