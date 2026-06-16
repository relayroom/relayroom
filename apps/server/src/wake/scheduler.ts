/**
 * Periodic wake jobs (phase 05).
 *
 * This codebase has no scheduler/cron/queue (apps/server/src/index.ts only
 * serves). The simplest fit is boot-time setInterval, stopped on shutdown.
 *
 * NOTE (phase boundary): this consolidated runner is composed by phase 12. As of
 * phase 12 the BOOT WIRING lives in apps/server/src/index.ts (startWakeJobs is
 * called after createApp and stopped on shutdown). The test app (makeTestApp /
 * createApp) does NOT start the jobs, so tests stay deterministic and drive the
 * sweeps explicitly. Ticks: reconcile (05), eligibility sweep (05), wake-intent
 * expiry (02), governance detect + resolve (08).
 *
 * Single-instance assumption: the current deploy is one server process. The jobs
 * are idempotent (reconcile dedups, sweep coalesces via shouldWake), so running on
 * multiple instances does not break correctness - it only duplicates work. For
 * horizontal scaling, gate the jobs behind pg_try_advisory_lock leader election.
 * That is OUT OF SCOPE for this phase (v2, consistent with spec 15).
 */
import type { Bus } from '../bus'
import type { Db } from '@relayroom/db'
import { reconcileWakeLedger } from './reconcile'
import { runEligibilitySweep } from './sweep'
import { expireStale } from './state'
import { autoCloseIdleThreads } from './autoclose'
import { resolveStaleAlerts, runGovernanceDetection } from '../governance/detect'

export const RECONCILE_INTERVAL_MS = 60_000 // 1 min: phantom detection (ledger catch-up)
export const SWEEP_INTERVAL_MS = 30_000 // 30 s: recover suppressed parts (window freed)
export const GOVERNANCE_INTERVAL_MS = 60_000 // 1 min: risk detection + auto-resolve (phase 08)
export const EXPIRY_INTERVAL_MS = 30_000 // 30 s: expire unactivated wake_intents (phase 02 reserve refund)
export const AUTOCLOSE_INTERVAL_MS = 5 * 60_000 // 5 min: auto-close idle threads (backstop)

export interface WakeJobs {
  stop(): void
}

export interface StartWakeJobsOptions {
  reconcileMs?: number
  sweepMs?: number
  governanceMs?: number
  expiryMs?: number
  autocloseMs?: number
}

/**
 * Start the periodic wake jobs. Each tick is wrapped in try/catch (a throwing
 * setInterval callback would kill the timer) and the timers are unref'd so they do
 * not keep the process alive during graceful shutdown. Returns a handle with stop().
 */
export function startWakeJobs(db: Db, bus: Bus, opts: StartWakeJobsOptions = {}): WakeJobs {
  const reconcileMs = opts.reconcileMs ?? RECONCILE_INTERVAL_MS
  const sweepMs = opts.sweepMs ?? SWEEP_INTERVAL_MS
  const governanceMs = opts.governanceMs ?? GOVERNANCE_INTERVAL_MS
  const expiryMs = opts.expiryMs ?? EXPIRY_INTERVAL_MS
  const autocloseMs = opts.autocloseMs ?? AUTOCLOSE_INTERVAL_MS

  // Per-job re-entrancy guard: skip a tick if the PREVIOUS run of the same job is
  // still in flight. A slow reconcile/sweep otherwise overlaps itself (setInterval
  // fires regardless), and concurrent sweeps amplify the budget/lease races. Each
  // safe() call gets its own `running` flag via closure.
  const safe = (name: string, fn: () => Promise<unknown>) => {
    let running = false
    return async () => {
      if (running) { console.warn(`[wake] ${name} still running - skipping this tick`); return }
      running = true
      try { await fn() } catch (e) { console.error(`[wake] ${name} failed`, e) } finally { running = false }
    }
  }

  const timers: ReturnType<typeof setInterval>[] = []
  timers.push(setInterval(safe('reconcile', () => reconcileWakeLedger(db)), reconcileMs))
  timers.push(setInterval(safe('sweep', () => runEligibilitySweep(db, bus)), sweepMs))
  // Wake-intent expiry (phase 02): mark unactivated pending/delivered wakes past
  // their expiresAt as 'expired' so their reserve frees from the rolling window
  // (spec 5: next tick reclaims, no infinite sleep). Idempotent + DB-backed.
  timers.push(setInterval(safe('expiry', () => expireStale(db)), expiryMs))
  // Idle-thread auto-close (backstop): close still-active threads with no activity
  // for the idle window so a forgotten-open thread stops waking its participants.
  timers.push(setInterval(safe('autoclose', () => autoCloseIdleThreads(db)), autocloseMs))
  // Governance detection (phase 08): raise alerts on tripped patterns, then close
  // alerts whose pattern has stopped. Both are idempotent and DB-backed.
  timers.push(
    setInterval(
      safe('governance', async () => {
        await runGovernanceDetection(db)
        await resolveStaleAlerts(db)
      }),
      governanceMs,
    ),
  )
  for (const t of timers) t.unref?.()

  return {
    stop() {
      for (const t of timers) clearInterval(t)
    },
  }
}
