/**
 * Wake issuance choke point (phase 05).
 *
 * `shouldWake` is THE single wake-decision point that every path goes through
 * (04 send/reply pipeline, 05 eligibility sweep, 07 catch-up). When issuance is
 * permitted it composes 03 `reserve` (budget gate) + 02 `ensurePending` (state
 * machine) in ONE transaction, then records a wake_event ledger-control row. The
 * pager signal (bus.emit) happens AFTER commit, outside the transaction, because
 * waking a tmux agent is a non-idempotent external side effect (spec 6).
 *
 * INVARIANT (spec 3): CONTROL (issuance counter via wakeIntents/wakeEvents) is
 * kept SEPARATE from the LEDGER (events.usage, the real billed turns). shouldWake
 * never blocks billing; it only governs whether a nudge fires. The reconcile job
 * compares the two and flags phantoms.
 *
 * INVARIANT (02 coalescing): at most one active wake per agent. Concurrent
 * shouldWake calls collapse to a single issued wake via the partial unique index
 * `wake_intent_agent_active`; the losers re-interpret as suppress:idle_already_pending.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Bus } from '../bus'
import type { Db } from '@relayroom/db'
import { agents, wakeEvents, wakeIntents } from '@relayroom/db'
import { ACTIVE_WAKE_STATES, ensurePending } from './state'
import { reserve, type ReserveReason } from './budget'

export type WakeSuppressReason =
  | 'idle_already_pending'
  | 'budget_exhausted'
  | 'banned'
  | 'not_idle'
  | 'no_owner'
  | 'unknown_agent'
  | 'limited'

export type WakeDecision =
  | { action: 'issue'; wakeId: string; epoch: number; reason: string }
  | { action: 'suppress'; reason: WakeSuppressReason }

export interface ShouldWakeInput {
  /** activation epoch this wake targets (fencing vs stale activation). Defaults
   *  to the agent's CURRENT activationEpoch when omitted (sweep/catch-up callers
   *  that don't already hold it). */
  epoch?: number
  urgent?: boolean
  /** provenance string stamped on the wake_intent ('message' | 'reply' | 'sweep' | 'catchup'). */
  reason?: string
  /** sender provenance recorded on wake_event for audit/governance (08/10). */
  senderPart?: string
  senderUserId?: string | null
  /**
   * Feature-flag enforcement gate (phase 12). When true (default), the budget
   * reserve gate (03) applies and an over-budget recipient is suppressed. When
   * false (flag OFF), the budget gate is BYPASSED: an idle+pending part is woken
   * unconditionally (legacy behavior). Coalescing (02) is ALWAYS on regardless
   * of this flag (spec 12). The control-side wake_event is still recorded either
   * way so OFF dogfooding builds a budget baseline.
   */
  enforce?: boolean
}

/** Map a denying reserve reason (03) to the suppress reason surfaced to callers. */
function suppressFromReserve(reason: ReserveReason): WakeSuppressReason {
  if (reason === 'no_owner') return 'no_owner'
  return 'budget_exhausted'
}

/**
 * THE wake-decision choke point. Evaluates every gate inside one transaction and,
 * if all pass, atomically reserves budget + creates the wake_intent + writes the
 * control-side wake_event. Returns a WakeDecision. Does NOT signal the pager (that
 * is `issueWake`, called by the caller after commit).
 *
 * Gate order (cheapest first, spec 05):
 *   1. not idle / already pending  -> suppress:idle_already_pending (coalescing 1st line)
 *   2. banned (projectAccess.bannedAt)  -> suppress:banned (placeholder until 09)
 *   3. budget reserve (03)  -> suppress:budget_exhausted | no_owner
 *   4. issue: ensurePending (02) + wake_event(suppressed=false)
 *
 * Concurrency: if a concurrent tx already created the active wake, ensurePending
 * coalesces (created=false) and we re-interpret as suppress:idle_already_pending.
 * Never double-issue.
 */
export async function shouldWake(
  db: Db,
  agentId: string,
  input: ShouldWakeInput = {},
): Promise<WakeDecision> {
  return db.transaction(async (tx) => {
    // Resolve owner + project + current epoch for the gates and the issued row.
    const [agent] = await tx
      .select({
        projectId: agents.projectId,
        ownerUserId: agents.ownerUserId,
        activationEpoch: agents.activationEpoch,
        limitedUntil: agents.limitedUntil,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    if (!agent) return { action: 'suppress', reason: 'unknown_agent' } as const

    const ownerUserId = agent.ownerUserId ?? null
    const epoch = input.epoch ?? agent.activationEpoch
    const urgent = input.urgent ?? false
    const enforce = input.enforce ?? true

    // 1. not idle / already pending (coalescing 1st line of defense).
    const active = await tx
      .select({ id: wakeIntents.id })
      .from(wakeIntents)
      .where(
        and(
          eq(wakeIntents.agentId, agentId),
          inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
        ),
      )
      .limit(1)
    if (active.length > 0) return { action: 'suppress', reason: 'idle_already_pending' } as const

    // 2. banned gate (placeholder; projectAccess.bannedAt always null until 09).
    //    The column exists (01) so we hold the gate position now. When 09 lands,
    //    a banned (project, ownerUser) suppresses here with an audit suppress row.

    // 2.5 provider rate-limit park (self-reported via event type:'limited').
    //     While limitedUntil is in the future, waking is pointless - the agent's
    //     provider would reject the turn - so suppress WITHOUT reserving budget
    //     (a parked wake must not consume the owner's window). Delivery (message
    //     row + SSE emit) is untouched by design: this gates only the nudge.
    //     Resume is free: the 30s eligibility sweep re-runs shouldWake for
    //     idle+unread parts, and the first tick after limitedUntil passes issues.
    //     Deliberately NOT gated on `enforce` - this is availability, not policy:
    //     with the enforcement flag OFF a wake into a limited agent still fails.
    //     An audit suppress row (reason 'limited') is recorded on sender-attributed
    //     paths (message/reply) so the ledger explains the silence, but NOT on
    //     sweep re-checks - the 30s sweep re-evaluates every parked part each tick
    //     and would otherwise write an unbounded stream of identical rows.
    if (agent.limitedUntil && agent.limitedUntil.getTime() > Date.now()) {
      if (input.reason !== 'sweep') {
        await tx.insert(wakeEvents).values({
          ownerUserId,
          agentId,
          projectId: agent.projectId,
          urgent,
          suppressed: true,
          phantom: false,
          senderPart: input.senderPart ?? null,
          senderUserId: input.senderUserId ?? null,
          reason: 'limited',
        })
      }
      return { action: 'suppress', reason: 'limited' } as const
    }

    // 3. budget reserve (03). Decision only; the actual hold is the wakeIntent row.
    //    Feature-flag gate (12): only enforce the budget when enforce=true. When
    //    flag OFF we skip the reserve gate entirely so an idle+pending part wakes
    //    unconditionally (legacy). Coalescing (gate 1 above) still applies.
    const decision = enforce
      ? await reserve(tx, { ownerUserId, projectId: agent.projectId, urgent })
      : ({ allowed: true, reason: 'ok' } as const)
    if (!decision.allowed) {
      const reason = suppressFromReserve(decision.reason)
      // Audit suppress row for budget_exhausted (08 detection / 10 audit see it).
      // no_owner gets no row (no principal to attribute it to, and not a budget signal).
      if (reason === 'budget_exhausted') {
        await tx.insert(wakeEvents).values({
          ownerUserId,
          agentId,
          projectId: agent.projectId,
          urgent,
          suppressed: true,
          phantom: false,
          senderPart: input.senderPart ?? null,
          senderUserId: input.senderUserId ?? null,
        })
      }
      return { action: 'suppress', reason } as const
    }

    // 4. issue: ensurePending (02) inside the same tx. The partial unique index is
    //    the final concurrency defense - a concurrent issuer makes this coalesce.
    const { intent, created } = await ensurePending(tx, agentId, {
      epoch,
      urgent,
      reason: input.reason,
    })
    if (!created) {
      // Lost the race: another tx issued the wake. Roll back nothing financial
      // (reserve makes no separate row), re-interpret as coalesce. The unique index
      // guarantees never-double-issue.
      return { action: 'suppress', reason: 'idle_already_pending' } as const
    }

    // Control-side ledger row for this issued wake (suppressed=false).
    await tx.insert(wakeEvents).values({
      ownerUserId,
      agentId,
      projectId: agent.projectId,
      wakeIntentId: intent.id,
      urgent,
      suppressed: false,
      phantom: false,
      senderPart: input.senderPart ?? null,
      senderUserId: input.senderUserId ?? null,
    })

    return { action: 'issue', wakeId: intent.wakeId, epoch: intent.epoch, reason: intent.reason ?? '' } as const
  })
}

export interface IssueWakeSignal {
  projectId: string
  projectSlug: string
  part: string
  threadId: string
  messageId: string
  subject: string
  fromPart: string
  wakeId: string
}

/**
 * Signal the pager that a wake was issued, via the existing bus (LISTEN/NOTIFY ->
 * SSE). Call AFTER the shouldWake transaction commits. The bus signal is a
 * non-idempotent side effect (spec 6); if it is lost the wake_intent still exists
 * and the eligibility sweep / heartbeat re-signals. `wakeId` rides the payload so
 * 07's pager fencing can use it.
 */
export function issueWake(bus: Bus, signal: IssueWakeSignal): void {
  bus.emit('message', {
    kind: 'message',
    projectId: signal.projectId,
    project: signal.projectSlug,
    part: signal.part,
    threadId: signal.threadId,
    messageId: signal.messageId,
    subject: signal.subject,
    fromPart: signal.fromPart,
    wakeId: signal.wakeId,
  })
}
