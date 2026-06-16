import { serve } from '@hono/node-server'
import { createDb, runMigrations } from '@relayroom/db'
import { createApp } from './app'
import { createBus } from './bus'
import { startWakeJobs } from './wake/scheduler'
import { ensureWakeBudgetDefault } from './wake/flag'
import { startTelemetry } from '@relayroom/telemetry'

const port = Number(process.env.PORT ?? 48801)
const db = createDb()
await runMigrations(db)
// Turn the wake-budget throttle ON by default for this deployment (idempotent;
// seeds a global config row only if absent) so runaway wake loops are capped. If the
// seed FAILS, the global flag stays absent and isWakeBudgetEnabled defaults to OFF -
// i.e. the server would serve with NO loop throttle (the exact token-burn loop we
// guard against). Refuse to start rather than run unprotected.
await ensureWakeBudgetDefault(db).catch((e) => {
  console.error('[wake] budget seed FAILED - refusing to start (would run with the loop throttle OFF):', e)
  process.exit(1)
})
const bus = createBus({ connectionString: process.env.DATABASE_URL })
const app = createApp(db, bus)
const server = serve({ fetch: app.fetch, port })
console.log(`[hub] server listening on :${port}`)

// Periodic wake jobs (phase 12 boot wiring): the consolidated scheduler runs the
// reconcile (05), eligibility sweep (05), wake-intent expiry (02), and governance
// detect/resolve (08) ticks. Started here at boot, stopped on shutdown. The test
// app (makeTestApp) does NOT start these so tests stay deterministic.
const jobs = startWakeJobs(db, bus)
console.log('[jobs] started periodic wake jobs (reconcile, sweep, expiry, governance)')

// CE telemetry (F1): anonymous beacons to the HQ collector. OFF until an admin
// opts in, timeout-bounded, never throws - safe to start unconditionally.
const telemetry = startTelemetry(db)

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return // a second signal during drain must not double-close
  shuttingDown = true
  console.log(`[hub] received ${signal}, shutting down…`)
  jobs.stop()
  telemetry.stop()
  // Drain in-flight requests before tearing down the bus/DB (so a Watchtower restart
  // or SIGTERM doesn't cut off a request mid-flight). Bounded: force-close after 10s.
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { console.warn('[hub] drain timed out - forcing close'); resolve() }, 10_000)
    server.close(() => { clearTimeout(t); resolve() })
  })
  await bus.close().catch(() => {})
  await db.$client.end().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
