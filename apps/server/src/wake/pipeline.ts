/**
 * Unified send/reply dispatch pipeline (phase 04).
 *
 * send / reply / (future) recipient-add ALL flow through `dispatch` so they share
 * one set of rules: effective-recipient resolution, the maxBroadcastRecipients hard
 * cap (human excluded), the stable-principal loop-breaker, message + messageRecipients
 * row creation (+ denormalized recipientCount), and per-recipient wake issuance
 * (reserve gate -> ensurePending). Delivery (SSE emit) is kept independent of wake:
 * a budget-exhausted recipient still gets the message row + emit, only the wake is
 * suppressed. (spec 4, 5, 8)
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '@relayroom/db'
import {
  agents,
  getOrCreateAgent,
  messageRecipients,
  messages,
  wakeEvents,
} from '@relayroom/db'
import { checkAndBumpDirectCooldown } from '../priority/direct-cooldown'
import { shouldWake } from './issuance'

// ── Loop-breaker: in-memory sliding window keyed on the STABLE principal ─────────
// Spec 8 + 15.1. The key is (ownerUserId|connectionId), NOT the ephemeral part,
// so rotating `part` cannot evade it. Approximate (process-local) by design: this
// is a preventive control gate (spec 3), not the ledger. Governance (spec 10)
// catches what leaks across instances via DB aggregation. messages has no
// fromUserId column, so a DB-count loop-breaker is not possible anyway.

const SEND_RATE_PER_MIN = 20 // spec 15.1
const IDENTICAL_LIMIT = 3 // spec 15.1: same payload 3x in 60s
const WINDOW_MS = 60_000

interface PrincipalWindow {
  sends: number[] // send timestamps (ms) in the last 60s
  identical: Map<string, number[]> // payloadHash -> timestamps in last 60s
}
const windows = new Map<string, PrincipalWindow>()

function prune(ts: number[], now: number): number[] {
  // drop entries older than the rolling window
  let i = 0
  while (i < ts.length && ts[i]! <= now - WINDOW_MS) i++
  return i > 0 ? ts.slice(i) : ts
}

/** Stable-principal key. Prefer ownerUserId (the budget principal); fall back to
 * connectionId so an unowned/legacy agent is still rate-limited per connection. */
function principalKey(ownerUserId: string | null, connectionId: string): string {
  return ownerUserId ? `u:${ownerUserId}` : `c:${connectionId}`
}

/** Hash of (threadId scope + body) so identical re-sends to the same thread trip
 * the identical-payload breaker. New-thread sends hash on subject+body instead. */
function payloadHash(scope: string, body: string): string {
  return createHash('sha256').update(`${scope}\n${body}`).digest('hex')
}

export interface LoopBreakerResult {
  ok: boolean
  reason?: 'rate' | 'identical'
}

/** Records this send attempt and returns whether it trips the loop-breaker.
 * Call EXACTLY ONCE per accepted send/reply, BEFORE doing DB writes (so a tripped
 * send does no work). Pure in-memory; safe to call on the hot path. */
export function checkLoopBreaker(
  ownerUserId: string | null,
  connectionId: string,
  scope: string,
  body: string,
  now = Date.now(),
): LoopBreakerResult {
  const key = principalKey(ownerUserId, connectionId)
  let w = windows.get(key)
  if (!w) {
    w = { sends: [], identical: new Map() }
    windows.set(key, w)
  }

  w.sends = prune(w.sends, now)
  if (w.sends.length >= SEND_RATE_PER_MIN) return { ok: false, reason: 'rate' }

  const h = payloadHash(scope, body)
  const hits = prune(w.identical.get(h) ?? [], now)
  if (hits.length >= IDENTICAL_LIMIT) return { ok: false, reason: 'identical' }

  // accept: record
  w.sends.push(now)
  hits.push(now)
  w.identical.set(h, hits)
  return { ok: true }
}

/** Test-only: reset the in-memory loop-breaker windows so independent test cases
 * do not bleed counts into each other. Not used by production code. */
export function resetLoopBreaker(): void {
  windows.clear()
}

// ── Recipient resolution ────────────────────────────────────────────────────────

/** The `human` part is the human notification lane, never an agent wake target.
 * Excluded from the broadcast cap and from ensurePending. (spec 7 needsHuman / 8) */
export const HUMAN_PART = 'human'

export interface ResolvedRecipient {
  part: string
  agentId: string
  ownerUserId: string | null
  activationEpoch: number
  isHuman: boolean
}

export type RecipientsSpec =
  | { mode: 'send'; to: string[] }
  | { mode: 'reply'; threadId: string }

/** Resolve the effective recipient agent set for a dispatch.
 * - mode 'send': explicit `to[]` (deduped).
 * - mode 'reply': union of past senders + past recipients in the thread, minus
 *   the sender's own part (mirrors the existing reply behavior at mcp.ts).
 * getOrCreateAgent makes each part a concrete agent row (ownerUserId may be null
 * for a part that has never connected). */
export async function computeRecipients(
  db: Db,
  projectId: string,
  fromPart: string,
  spec: RecipientsSpec,
): Promise<ResolvedRecipient[]> {
  let parts: string[]
  if (spec.mode === 'send') {
    parts = [...new Set(spec.to)]
  }
  else {
    const fromAgentsAlias = alias(agents, 'from_agents')
    const senders = await db.selectDistinct({ part: fromAgentsAlias.part })
      .from(messages)
      .innerJoin(fromAgentsAlias, eq(messages.fromAgentId, fromAgentsAlias.id))
      .where(eq(messages.threadId, spec.threadId))
    const recips = await db.selectDistinct({ part: fromAgentsAlias.part })
      .from(messageRecipients)
      .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
      .innerJoin(fromAgentsAlias, eq(messageRecipients.agentId, fromAgentsAlias.id))
      .where(eq(messages.threadId, spec.threadId))
    parts = [...new Set([...senders, ...recips].map(p => p.part))]
  }
  parts = parts.filter(p => p !== fromPart)

  const resolved: ResolvedRecipient[] = []
  for (const part of parts) {
    // Coding agents are created solely via the web UI (connectAgent). A send/reply
    // addressed to an unregistered part is DROPPED, never auto-created - this stops
    // a stray `to: ['typo']` (or a wildcard) from conjuring phantom agents and
    // broadening the recipient set. The HUMAN part is the one exception: it is a
    // virtual participant (no coding CLI), so we materialize its row on demand.
    const agent = part === HUMAN_PART
      ? await getOrCreateAgent(db, projectId, part)
      : (await db.select().from(agents)
          // Soft-deleted agents are NOT recipients: addressing/reviving a removed
          // part must not wake it (a stale `to:` or thread history would otherwise
          // resurrect a deleted agent into the recipient set).
          .where(and(eq(agents.projectId, projectId), eq(agents.part, part), isNull(agents.deletedAt)))
          .limit(1))[0]
    if (!agent) continue
    resolved.push({
      part,
      agentId: agent.id,
      ownerUserId: agent.ownerUserId ?? null,
      activationEpoch: agent.activationEpoch,
      isHuman: part === HUMAN_PART,
    })
  }
  return resolved
}

// ── Broadcast cap ───────────────────────────────────────────────────────────────

/** Effective broadcast cap. projects.maxBroadcastRecipients ?? min(N, 8), where
 * N = number of agent rows in the project. (spec 8, 15.1) The `human` part is
 * excluded from the counted recipients before comparison (done in dispatch). */
export async function effectiveCap(
  db: Db,
  projectId: string,
  configured: number | null,
): Promise<number> {
  if (configured != null) return configured
  // Count only WAKEABLE agents: exclude soft-deleted rows and the virtual human part,
  // so the default cap reflects how many real coding agents could actually be woken
  // (a pile of deleted parts must not silently widen the broadcast).
  const rows = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.projectId, projectId), isNull(agents.deletedAt), ne(agents.part, HUMAN_PART)))
  return Math.min(rows.length, 8)
}

export class BroadcastCapError extends Error {
  constructor(public readonly count: number, public readonly cap: number) {
    super(
      `broadcast rejected: ${count} agent recipients exceeds this project's cap of ${cap}. `
      + `Narrow the recipient list, split into smaller sends, or ask a project manager `
      + `to raise maxBroadcastRecipients in project settings.`,
    )
    this.name = 'BroadcastCapError'
  }
}

export class LoopBreakerError extends Error {
  constructor(public readonly reason: 'rate' | 'identical') {
    super(
      reason === 'rate'
        ? `send rejected: rate limit of ${SEND_RATE_PER_MIN} sends/min for your account was exceeded. Slow down or batch your messages.`
        : `send rejected: the same message to the same thread was sent ${IDENTICAL_LIMIT} times within 60s (loop detected). If this is intentional, change the body or wait.`,
    )
    this.name = 'LoopBreakerError'
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────────

export interface DispatchInput {
  projectId: string
  projectSlug: string
  threadId: string
  subject: string // for the bus event / loop-breaker scope on new threads
  fromPart: string
  fromAgentId: string
  fromUserId: string | null // ctx.userId: stable principal of the sender
  connectionId: string // ctx.connectionId: loop-breaker fallback key
  body: string
  urgent: boolean
  recipientsSpec: RecipientsSpec
  maxBroadcastRecipients: number | null // projects.maxBroadcastRecipients
  emit: (part: string, messageId: string) => void // wraps bus.emit('message', HubBusEvent)
  /**
   * Feature-flag enforcement gate (phase 12). When true (default), enforcement
   * applies: broadcast-cap hard reject, loop-breaker hard reject, direct cooldown,
   * and the budget reserve gate (via shouldWake). When false (flag OFF), those
   * REJECTS/SUPPRESSIONS are bypassed (legacy: everyone delivered + woken), BUT:
   *   - coalescing (02, via shouldWake/ensurePending) ALWAYS applies (spec 12), and
   *   - the loop-breaker trip is still RECORDED as a suppressed wake_event so
   *     governance detection (08) keeps a baseline; only the hard reject is gated.
   * This matches spec 17 "예산 소진 시 전달은 유지" - delivery never depends on the gate.
   */
  enforce?: boolean
}

export interface DispatchResult {
  messageId: string
  recipientCount: number
  suppressed: number // recipients delivered but not woken (budget exhausted)
}

/** THE unified send/reply pipeline. Order (spec 8):
 *   1. loop-breaker (stable principal) -> reject early, no DB writes
 *   2. compute recipients
 *   3. enforce broadcast cap (human excluded) -> reject
 *   4. create message (+denormalized recipientCount) + messageRecipients rows
 *   5. per agent recipient: reserve (03) then ensurePending (02); emit always
 * Throws BroadcastCapError / LoopBreakerError for rejects so the tool returns a
 * clear isError result. */
export async function dispatch(db: Db, input: DispatchInput): Promise<DispatchResult> {
  const enforce = input.enforce ?? true
  // 1. loop-breaker (BEFORE any write). scope = threadId so identical re-replies trip.
  const scope = input.recipientsSpec.mode === 'reply'
    ? input.recipientsSpec.threadId
    : input.subject
  const lb = checkLoopBreaker(input.fromUserId, input.connectionId, scope, input.body)
  if (!lb.ok) {
    // Persist the trip as a suppressed control row so governance detection (08) can
    // aggregate loop-breaker trips on the STABLE principal (senderUserId), 60-min
    // rolling, per-project. The breaker itself stays in-memory (its prevention is
    // process-local by design); this row is only a provenance signal, never a wake.
    // senderUserId is required (it is the aggregation key); skip for unowned senders.
    if (input.fromUserId) {
      await db.insert(wakeEvents).values({
        ownerUserId: input.fromUserId, // subject = the sender who tripped the breaker
        projectId: input.projectId,
        urgent: input.urgent,
        suppressed: true,
        phantom: false,
        senderPart: input.fromPart,
        senderUserId: input.fromUserId,
        reason: 'loop_breaker',
      })
    }
    // Feature-flag gate (12): the trip is always RECORDED (telemetry/governance
    // baseline above), but the HARD REJECT only fires when enforcing. With the
    // flag OFF we let the send proceed (legacy) so dogfooding does not block
    // legitimate traffic; detection (08) still sees the trips it aggregated.
    if (enforce) throw new LoopBreakerError(lb.reason!)
  }

  // 2. recipients
  const recipients = await computeRecipients(db, input.projectId, input.fromPart, input.recipientsSpec)
  const agentRecipients = recipients.filter(r => !r.isHuman)

  // 3. cap (human excluded). Feature-flag gate (12): the broadcast-cap hard reject
  //    only fires when enforcing; OFF lets the wide send through (legacy).
  if (enforce) {
    const cap = await effectiveCap(db, input.projectId, input.maxBroadcastRecipients)
    if (agentRecipients.length > cap) throw new BroadcastCapError(agentRecipients.length, cap)
  }

  // 4. message + denormalized recipientCount (counts ALL recipients incl. human, the
  //    fan-out width for ledger/audit per 01 comment). messageRecipients for all.
  const recipientCount = recipients.length
  const [message] = await db.insert(messages)
    .values({
      threadId: input.threadId,
      fromAgentId: input.fromAgentId,
      body: input.body,
      urgent: input.urgent,
      recipientCount,
    })
    .returning()

  for (const r of recipients) {
    await db.insert(messageRecipients)
      .values({ messageId: message.id, agentId: r.agentId })
      .onConflictDoNothing()
  }

  // 5. per agent recipient: route through the single wake choke point `shouldWake`
  //    (05), which composes reserve (03) + ensurePending (02) in one tx and writes
  //    the control-side wake_event. human gets the row (above) but no wake.
  //    Suppressed recipients keep the message row; the refill/eligibility sweep (05)
  //    recovers them when budget frees up. Delivery (emit) is independent of wake.
  // width-1 (direct) gets a per-(sender->recipient) cooldown so a 1:1 ping-pong
  // cannot wake the peer on every turn. Applies regardless of urgent (a ping-pong
  // can be urgent too); when the cooldown blocks, the message is still delivered
  // and only the wake is suppressed. (spec 7, 15.1)
  // Direct cooldown is enforcement; gate it (12). OFF skips the cooldown entirely.
  const isDirect = enforce && agentRecipients.length === 1
  let suppressed = 0
  for (const r of agentRecipients) {
    if (isDirect) {
      const { allowed } = await checkAndBumpDirectCooldown(
        db,
        input.fromAgentId,
        r.agentId,
        input.projectId,
      )
      if (!allowed) {
        // Cooldown: keep delivery, suppress only the wake. Record a suppressed
        // control row (reason=direct_cooldown) for audit/governance (08/10), then
        // emit and move on without reserving a wake.
        if (r.ownerUserId) {
          await db.insert(wakeEvents).values({
            ownerUserId: r.ownerUserId,
            agentId: r.agentId,
            projectId: input.projectId,
            urgent: input.urgent,
            suppressed: true,
            phantom: false,
            senderPart: input.fromPart,
            senderUserId: input.fromUserId,
          })
        }
        suppressed++
        input.emit(r.part, message.id)
        continue
      }
    }
    const decision = await shouldWake(db, r.agentId, {
      epoch: r.activationEpoch,
      urgent: input.urgent,
      reason: input.recipientsSpec.mode === 'reply' ? 'reply' : 'message',
      senderPart: input.fromPart,
      senderUserId: input.fromUserId,
      enforce, // 12: budget reserve gate applies only when enforcing
    })
    if (decision.action !== 'issue') suppressed++
    input.emit(r.part, message.id) // emit ALWAYS (delivery/SSE independent of wake)
  }
  // human part: emit so the dashboard/human lane sees it, no wake.
  for (const r of recipients) {
    if (r.isHuman) input.emit(r.part, message.id)
  }

  return { messageId: message.id, recipientCount, suppressed }
}
