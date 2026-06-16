/**
 * Governance risk detection (phase 08, spec 10.1 + 15.1).
 *
 * Periodically aggregates wake/broadcast telemetry (`wake_event`) on the STABLE
 * principal (`wake_event.senderUserId`), 60-min rolling, per-project, and raises one
 * `governance_alert` per risk pattern for a manager to review. Aggregating on the
 * stable principal (not the ephemeral `senderPart`) means rotating `part` cannot
 * hide a pattern.
 *
 * Detection -> alert is AUTOMATIC. ban is MANUAL (phase 09). Thresholds are
 * deliberately conservative (false-positive avoidance); tune via dogfooding.
 *
 * Dedup: at most one OPEN (resolvedAt IS NULL) alert per (project, subject, kind).
 * Enforced atomically by the partial unique index `governance_alert_open_uniq`
 * (migration 0007) + onConflictDoNothing, so concurrent ticks cannot double-insert.
 *
 * Auto-resolve: when a pattern falls back below threshold (e.g. the window rolls
 * past the offending events), the open alert is closed (resolvedAt = now). A manual
 * ban-driven resolve is owned by phase 09; this module only closes alerts whose
 * pattern has stopped.
 *
 * BOOT WIRING is owned by phase 12 (the consolidated scheduler). This module only
 * EXPORTS the detector so it is unit-testable; index.ts is intentionally NOT edited.
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { governanceAlerts, wakeEvents } from '@relayroom/db'

// Conservative defaults (spec 15.1). Tuned via dogfooding (phase 12).
export const GOVERNANCE_THRESHOLDS = {
  windowMs: 60 * 60_000, // 60-min rolling window
  loopBreakerTrips: 3, // >= 3 loop-breaker trips / 60 min
  phantomTurns: 5, // >= 5 phantom turns / 60 min
  broadcastSpikeWakes: 60, // >= 60 wakes triggered by one sender / 60 min
  budgetDrainShare: 0.6, // sender consumes >= 60% of OTHER owners' wake reservations
  budgetDrainMinWakes: 20, // ...only when the sample of others' wakes is large enough
} as const

export type GovernanceKind =
  | 'loop_breaker'
  | 'phantom_turns'
  | 'broadcast_spike'
  | 'budget_drain'

export interface DetectedSignal {
  projectId: string
  subjectUserId: string // = senderUserId (stable principal)
  kind: GovernanceKind
  detail: Record<string, unknown>
}

interface GroupRow {
  projectId: string
  senderUserId: string
  total: number // all wake_events for this (project, sender) in window
  phantom: number // ...where phantom = true
  loopBreaker: number // ...where reason = 'loop_breaker'
  othersOwned: number // ...where ownerUserId <> senderUserId (consuming others' budget)
}

const WINDOW_MIN = GOVERNANCE_THRESHOLDS.windowMs / 60_000

/**
 * Aggregate wake_events in the rolling window into per-(project, sender) groups and
 * decide which thresholds are tripped. Pure-ish: one grouped query, then in-memory
 * threshold comparison (easy to unit-test the decision logic).
 */
export async function collectSignals(db: Db, now = new Date()): Promise<DetectedSignal[]> {
  const since = new Date(now.getTime() - GOVERNANCE_THRESHOLDS.windowMs)

  const rows = (await db
    .select({
      projectId: wakeEvents.projectId,
      senderUserId: wakeEvents.senderUserId,
      total: sql<number>`count(*)::int`,
      phantom: sql<number>`count(*) filter (where ${wakeEvents.phantom})::int`,
      loopBreaker: sql<number>`count(*) filter (where ${wakeEvents.reason} = 'loop_breaker')::int`,
      othersOwned: sql<number>`count(*) filter (where ${wakeEvents.ownerUserId} <> ${wakeEvents.senderUserId})::int`,
    })
    .from(wakeEvents)
    .where(
      and(
        gte(wakeEvents.createdAt, since),
        sql`${wakeEvents.senderUserId} is not null`,
        sql`${wakeEvents.projectId} is not null`,
      ),
    )
    .groupBy(wakeEvents.projectId, wakeEvents.senderUserId)) as GroupRow[]

  const signals: DetectedSignal[] = []
  for (const r of rows) {
    if (!r.projectId || !r.senderUserId) continue
    const base = { projectId: r.projectId, subjectUserId: r.senderUserId }

    if (r.loopBreaker >= GOVERNANCE_THRESHOLDS.loopBreakerTrips) {
      signals.push({
        ...base,
        kind: 'loop_breaker',
        detail: { count: r.loopBreaker, windowMin: WINDOW_MIN, threshold: GOVERNANCE_THRESHOLDS.loopBreakerTrips },
      })
    }
    if (r.phantom >= GOVERNANCE_THRESHOLDS.phantomTurns) {
      signals.push({
        ...base,
        kind: 'phantom_turns',
        detail: { count: r.phantom, windowMin: WINDOW_MIN, threshold: GOVERNANCE_THRESHOLDS.phantomTurns },
      })
    }
    if (r.total >= GOVERNANCE_THRESHOLDS.broadcastSpikeWakes) {
      signals.push({
        ...base,
        kind: 'broadcast_spike',
        detail: { count: r.total, windowMin: WINDOW_MIN, threshold: GOVERNANCE_THRESHOLDS.broadcastSpikeWakes },
      })
    }
    // budget_drain: this sender consumed others' wake budget (ownerUserId != sender)
    // for >= budgetDrainShare of a sufficiently large sample.
    if (r.othersOwned >= GOVERNANCE_THRESHOLDS.budgetDrainMinWakes) {
      const share = r.othersOwned / r.total
      if (share >= GOVERNANCE_THRESHOLDS.budgetDrainShare) {
        signals.push({
          ...base,
          kind: 'budget_drain',
          detail: {
            othersOwned: r.othersOwned,
            total: r.total,
            share: Math.round(share * 100),
            windowMin: WINDOW_MIN,
          },
        })
      }
    }
  }
  return signals
}

/**
 * Raise a governance alert, deduped to at most one OPEN row per (project, subject,
 * kind). Returns true if a new alert was inserted, false if one was already open.
 * Atomic via the partial unique index `governance_alert_open_uniq`.
 */
export async function raiseAlert(db: Db, s: DetectedSignal): Promise<boolean> {
  const inserted = await db
    .insert(governanceAlerts)
    .values({
      projectId: s.projectId,
      subjectUserId: s.subjectUserId,
      kind: s.kind,
      detail: s.detail,
    })
    .onConflictDoNothing({
      target: [governanceAlerts.projectId, governanceAlerts.subjectUserId, governanceAlerts.kind],
      where: isNull(governanceAlerts.resolvedAt),
    })
    .returning({ id: governanceAlerts.id })
  return inserted.length > 0
}

/** One detection tick: collect signals and raise (deduped) alerts. Returns the
 *  number of NEW alerts raised this tick. */
export async function runGovernanceDetection(db: Db, now = new Date()): Promise<number> {
  const signals = await collectSignals(db, now)
  let raised = 0
  for (const s of signals) {
    if (await raiseAlert(db, s)) raised++
  }
  return raised
}

/**
 * Close open alerts whose pattern has stopped (fallen back below threshold in the
 * current window). Does NOT touch alerts whose pattern is still tripping. Manual
 * ban-driven resolve is owned by phase 09. Returns the number of alerts resolved.
 */
export async function resolveStaleAlerts(db: Db, now = new Date()): Promise<number> {
  const open = await db
    .select({
      id: governanceAlerts.id,
      projectId: governanceAlerts.projectId,
      subjectUserId: governanceAlerts.subjectUserId,
      kind: governanceAlerts.kind,
    })
    .from(governanceAlerts)
    .where(isNull(governanceAlerts.resolvedAt))

  if (open.length === 0) return 0

  // Re-evaluate the current window once; an alert is stale if its (project, subject,
  // kind) no longer appears in the live signal set.
  const live = await collectSignals(db, now)
  const liveKeys = new Set(live.map(s => `${s.projectId}|${s.subjectUserId}|${s.kind}`))

  let resolved = 0
  for (const a of open) {
    if (!a.subjectUserId) continue
    const key = `${a.projectId}|${a.subjectUserId}|${a.kind}`
    if (!liveKeys.has(key)) {
      await db
        .update(governanceAlerts)
        .set({ resolvedAt: now })
        .where(and(eq(governanceAlerts.id, a.id), isNull(governanceAlerts.resolvedAt)))
      resolved++
    }
  }
  return resolved
}
