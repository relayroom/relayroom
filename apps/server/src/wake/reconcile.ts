/**
 * Control/ledger reconciliation job (phase 05).
 *
 * Periodically compares the CONTROL side (issued/settled wakes: wakeEvents with
 * suppressed=false, phantom=false) against the LEDGER side (real billed turns:
 * events with type='complete' and a positive token usage) and flags any real turn
 * that has NO matching issued wake as a PHANTOM (wakeEvents.phantom=true).
 *
 * INVARIANT (spec 3): the two sides stay SEPARATE. This job does NOT block billing
 * or refund anything. A phantom is a governance SIGNAL (duplicate nudge, delayed
 * delivery, pager bug, or an agent that turned on its own) consumed by 08 detection
 * (spec 10.1: 5 phantoms / 60 min). The time-proximity match is an APPROXIMATION
 * (spec 6: tmux wake is a non-idempotent side effect, not exactly-once), so 08's
 * thresholds are deliberately conservative.
 *
 * Idempotent: a phantom row is stamped with the turn's own timestamp; re-running
 * over the same window will not double-insert (dedup on (agentId, createdAt)).
 */
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '@relayroom/db'
import { agents, events, wakeEvents } from '@relayroom/db'

/** Match radius: a real turn matches a settled wake within +/- this many ms.
 *  Default = wake_intent expiry (10 min) per the plan. */
export const MATCH_RADIUS_MS = 10 * 60 * 1000

/** How far back to rescan each run. Overlap is fine - dedup makes it idempotent. */
export const RECONCILE_LOOKBACK_MS = 30 * 60 * 1000

export interface ReconcileResult {
  scanned: number // real turns examined in the window
  phantomFlagged: number // new phantom rows inserted this run
}

interface Turn {
  agentId: string
  ownerUserId: string | null
  projectId: string
  at: Date // endedAt ?? createdAt
}

interface SettledWake {
  agentId: string
  at: Date
  consumed: boolean
}

/**
 * Scan the recent window, flag unmatched real turns as phantom. Greedy 1:1 match:
 * each real turn consumes the nearest unconsumed settled wake for the same agent
 * within MATCH_RADIUS_MS.
 */
export async function reconcileWakeLedger(
  db: Db,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const windowStart = new Date(now.getTime() - RECONCILE_LOOKBACK_MS)
  // Settled wakes can match a turn up to MATCH_RADIUS_MS earlier, so widen the
  // wake lookback by the radius.
  const wakeWindowStart = new Date(windowStart.getTime() - MATCH_RADIUS_MS)

  // LEDGER side: real billed turns. type='complete' with positive token sum.
  const tokenSum = sql<number>`
    coalesce((${events.usage} ->> 'input_tokens')::int, 0)
    + coalesce((${events.usage} ->> 'output_tokens')::int, 0)
    + coalesce((${events.usage} ->> 'cache_tokens')::int, 0)`
  const turnRows = await db
    .select({
      agentId: events.agentId,
      ownerUserId: agents.ownerUserId,
      projectId: events.projectId,
      endedAt: events.endedAt,
      createdAt: events.createdAt,
    })
    .from(events)
    .leftJoin(agents, eq(events.agentId, agents.id))
    .where(
      and(
        eq(events.type, 'complete'),
        gte(events.createdAt, windowStart),
        sql`${tokenSum} > 0`,
      ),
    )

  const turns: Turn[] = turnRows
    .filter((r): r is typeof r & { agentId: string } => !!r.agentId)
    .map(r => ({
      agentId: r.agentId,
      ownerUserId: r.ownerUserId ?? null,
      projectId: r.projectId,
      at: r.endedAt ?? r.createdAt,
    }))

  // CONTROL side: settled/issued wakes (real nudges, not suppressed, not phantom).
  const wakeRows = await db
    .select({ agentId: wakeEvents.agentId, createdAt: wakeEvents.createdAt })
    .from(wakeEvents)
    .where(
      and(
        eq(wakeEvents.suppressed, false),
        eq(wakeEvents.phantom, false),
        gte(wakeEvents.createdAt, wakeWindowStart),
      ),
    )
  const wakesByAgent = new Map<string, SettledWake[]>()
  for (const w of wakeRows) {
    if (!w.agentId) continue
    const list = wakesByAgent.get(w.agentId) ?? []
    list.push({ agentId: w.agentId, at: w.createdAt, consumed: false })
    wakesByAgent.set(w.agentId, list)
  }

  // Existing phantom timestamps per agent (for idempotent re-runs).
  const existingPhantoms = await db
    .select({ agentId: wakeEvents.agentId, createdAt: wakeEvents.createdAt })
    .from(wakeEvents)
    .where(and(eq(wakeEvents.phantom, true), gte(wakeEvents.createdAt, wakeWindowStart)))
  const phantomSet = new Set<string>()
  for (const p of existingPhantoms) {
    if (p.agentId) phantomSet.add(`${p.agentId}@${p.createdAt.getTime()}`)
  }

  let phantomFlagged = 0
  for (const turn of turns) {
    const candidates = wakesByAgent.get(turn.agentId) ?? []
    // Find nearest unconsumed wake within the radius.
    let best: SettledWake | undefined
    let bestDelta = Number.POSITIVE_INFINITY
    for (const w of candidates) {
      if (w.consumed) continue
      const delta = Math.abs(w.at.getTime() - turn.at.getTime())
      if (delta <= MATCH_RADIUS_MS && delta < bestDelta) {
        best = w
        bestDelta = delta
      }
    }
    if (best) {
      best.consumed = true
      continue
    }
    // Unmatched real turn -> phantom (idempotent on (agentId, turn time)).
    const key = `${turn.agentId}@${turn.at.getTime()}`
    if (phantomSet.has(key)) continue
    await db.insert(wakeEvents).values({
      ownerUserId: turn.ownerUserId,
      agentId: turn.agentId,
      projectId: turn.projectId,
      urgent: false,
      suppressed: false,
      phantom: true,
      createdAt: turn.at,
    })
    phantomSet.add(key)
    phantomFlagged++
  }

  return { scanned: turns.length, phantomFlagged }
}
