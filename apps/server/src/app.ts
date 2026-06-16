import type { Db } from '@relayroom/db'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bus } from './bus'
import { createMcpRoute, getAuthBase, getServerBase } from './routes/mcp'
import { createSseRoute } from './routes/sse'

/**
 * Allowed browser origins for /api/* CORS. Defaults to the dashboard (auth base).
 * Override with RELAYROOM_ALLOWED_ORIGINS (comma-separated) for multi-origin deploys.
 * Note: non-browser agent clients (pager/channel via node fetch) send no Origin and
 * are unaffected by CORS — this only constrains cross-site browser access.
 */
function getAllowedOrigins(): string[] {
  const raw = process.env.RELAYROOM_ALLOWED_ORIGINS ?? getAuthBase()
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export function createApp(db: Db, bus: Bus) {
  const app = new Hono()
  const allowedOrigins = getAllowedOrigins()
  // Whitelist the dashboard origin(s) instead of a wildcard — a wildcard + any
  // credentialed/legacy route is a cross-site read primitive.
  app.use('/api/*', cors({
    origin: origin => (allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
  }))
  app.get('/health', c => c.json({ ok: true }))

  // ── RFC 9728: OAuth Protected Resource metadata ───────────────────────────
  // MCP clients fetch this to discover the authorization server.
  app.get('/.well-known/oauth-protected-resource', (c) => {
    return c.json({
      resource: getServerBase(),
      authorization_servers: [getAuthBase()],
    })
  })

  // ── MCP resource server (F6b) ─────────────────────────────────────────────
  // Auth is ALWAYS enforced on /mcp.
  app.route('/mcp', createMcpRoute(db, bus))

  app.route('/api/sse', createSseRoute(db, bus))
  return app
}
