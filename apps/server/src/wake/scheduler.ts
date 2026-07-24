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
import { proposeKnowledgeDiff } from '@relayroom/db'
import { reconcileWakeLedger } from './reconcile'
import { runEligibilitySweep } from './sweep'
import { expireStale } from './state'
import { autoCloseIdleThreads } from './autoclose'
import { resolveStaleAlerts, runGovernanceDetection } from '../governance/detect'
import { runKnowledgeRetention } from '../knowledge/retention'
import { runKnowledgeMetricsRollup } from '../knowledge/metrics-rollup'
import { runExtractorSweep } from '../knowledge/extractor-sweep'
import { runKnowledgeGarbageCollection } from '../knowledge/retention'
import { runProposerSweep } from '../knowledge/proposer'

export const RECONCILE_INTERVAL_MS = 60_000 // 1 min: phantom detection (ledger catch-up)
export const SWEEP_INTERVAL_MS = 30_000 // 30 s: recover suppressed parts (window freed)
export const GOVERNANCE_INTERVAL_MS = 60_000 // 1 min: risk detection + auto-resolve (phase 08)
export const EXPIRY_INTERVAL_MS = 30_000 // 30 s: expire unactivated wake_intents (phase 02 reserve refund)
export const AUTOCLOSE_INTERVAL_MS = 5 * 60_000 // 5 min: auto-close idle threads (backstop)
// 15 min: retire expired knowledge (FEAT-0001). Relaxed on purpose - `recall`
// filters expires_at itself, so an expired entry is already unreadable and this
// only settles the stored state and the audit ledger behind it.
export const KNOWLEDGE_RETENTION_INTERVAL_MS = 15 * 60_000
// 1h: daily metrics rollup. Runs often but is idempotent - it recomputes the
// trailing window and upserts, so a frequent tick just keeps the recent days
// (whose precision is still accumulating) fresh. Cheap relative to a day.
export const KNOWLEDGE_METRICS_INTERVAL_MS = 60 * 60_000
// 60s: extractor sweep. Frequent because it is the loop's intake latency (a closed
// thread becomes a candidate within a tick); idempotent and lease-guarded, so a
// short interval is cheap.
export const KNOWLEDGE_EXTRACTOR_INTERVAL_MS = 60_000
// 6h: retention GC. Ageing-out is not time-critical; a relaxed interval keeps it off
// the hot path.
export const KNOWLEDGE_GC_INTERVAL_MS = 6 * 60 * 60_000
// 5min: reflection proposer (FEAT-0005 L4). It reacts to ACCUMULATED errors, so it
// is not latency-sensitive; the recurrence threshold (>=2 agents / >=3 times) is
// itself a debounce, so a relaxed interval avoids churn. Lease-guarded + idempotent.
export const KNOWLEDGE_PROPOSER_INTERVAL_MS = 5 * 60_000

export interface WakeJobs {
  stop(): void
}

export interface StartWakeJobsOptions {
  knowledgeRetentionMs?: number
  knowledgeMetricsMs?: number
  knowledgeExtractorMs?: number
  knowledgeGcMs?: number
  knowledgeProposerMs?: number
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
  const knowledgeRetentionMs = opts.knowledgeRetentionMs ?? KNOWLEDGE_RETENTION_INTERVAL_MS
  const knowledgeMetricsMs = opts.knowledgeMetricsMs ?? KNOWLEDGE_METRICS_INTERVAL_MS
  const knowledgeExtractorMs = opts.knowledgeExtractorMs ?? KNOWLEDGE_EXTRACTOR_INTERVAL_MS
  const knowledgeGcMs = opts.knowledgeGcMs ?? KNOWLEDGE_GC_INTERVAL_MS
  const knowledgeProposerMs = opts.knowledgeProposerMs ?? KNOWLEDGE_PROPOSER_INTERVAL_MS

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
  // Knowledge expiry (FEAT-0001). Not a wake job, but this is the process's only
  // scheduler, and it already gives every tick the re-entrancy guard and the
  // throwing-callback protection this needs too.
  timers.push(setInterval(safe('knowledge-retention', () => runKnowledgeRetention(db)), knowledgeRetentionMs))
  // Daily knowledge metrics (FEAT-0001 L2). Same scheduler for the same reasons as
  // retention: re-entrancy guard + throwing-callback protection, and it is not a
  // wake job but this is the only scheduler the process has.
  timers.push(setInterval(safe('knowledge-metrics', () => runKnowledgeMetricsRollup(db)), knowledgeMetricsMs))
  // Extractor + retention GC (FEAT-0004 L3). Same scheduler, same re-entrancy guard.
  timers.push(setInterval(safe('knowledge-extractor', () => runExtractorSweep(db)), knowledgeExtractorMs))
  timers.push(setInterval(safe('knowledge-gc', () => runKnowledgeGarbageCollection(db)), knowledgeGcMs))
  // Reflection proposer (FEAT-0005 L4): cluster recurring errors + contradicted
  // knowledge into pending proposals for human review. The only writer of the queue;
  // proposeKnowledgeDiff is idempotent on the open-signature index.
  timers.push(setInterval(safe('knowledge-proposer', () => runProposerSweep(db, { propose: proposeKnowledgeDiff })), knowledgeProposerMs))
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
