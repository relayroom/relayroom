import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '@relayroom/db'
import { agents, messageRecipients, messages, threads, wakeIntents } from '@relayroom/db'
import { ACTIVE_WAKE_STATES, markDelivered } from '../wake/state'

/**
 * 07. Server-side per-part wake lease + wakeId fencing + catch-up coalesce.
 *
 * Pure-ish DB functions split out of the route so they are unit-testable. The
 * lease lives on the agent's single ACTIVE wake_intent row (coalescing invariant
 * => at most one), replacing the pager's machine-local lockfile. This makes
 * "single pager per part" authoritative across machines: only the holder whose id
 * matches `leaseHolder` (and whose lease has not expired) may nudge.
 */

const DEFAULT_LEASE_TTL_MS = 45_000

export interface ClaimLeaseInput {
  agentId: string
  holder: string
  ttlMs?: number
}

export interface ClaimLeaseResult {
  ok: boolean
  /** the fencing token of the active wake the lease covers (on ok). */
  wakeId?: string
  /** true when another live holder owns the lease. */
  held?: boolean
  /** the current holder when refused. */
  holder?: string
  /** true when there is no active wake to lease (nothing to nudge). */
  noWake?: boolean
}

/** The single active wake row for an agent, or undefined (coalescing => <=1). */
async function activeWakeFor(db: Db, agentId: string) {
  const [row] = await db
    .select()
    .from(wakeIntents)
    .where(
      and(
        eq(wakeIntents.agentId, agentId),
        inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
      ),
    )
    .limit(1)
  return row
}

/**
 * Claim (or take over) the lease on the agent's active wake. Conditional UPDATE
 * succeeds only when the lease is free, expired, or already ours. A second live
 * claimant is refused with `held: true` + the current holder.
 */
export async function claimLease(db: Db, input: ClaimLeaseInput): Promise<ClaimLeaseResult> {
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const expiresAt = new Date(Date.now() + ttl)

  const updated = await db
    .update(wakeIntents)
    .set({ leaseHolder: input.holder, leaseExpiresAt: expiresAt })
    .where(
      and(
        eq(wakeIntents.agentId, input.agentId),
        inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
        sql`(${wakeIntents.leaseHolder} is null
          or ${wakeIntents.leaseExpiresAt} < now()
          or ${wakeIntents.leaseHolder} = ${input.holder})`,
      ),
    )
    .returning({ wakeId: wakeIntents.wakeId })

  if (updated.length > 0) {
    return { ok: true, wakeId: updated[0].wakeId }
  }

  // 0 rows: either no active wake, or a live lease held by someone else.
  const active = await activeWakeFor(db, input.agentId)
  if (!active) return { ok: false, noWake: true }
  return { ok: false, held: true, holder: active.leaseHolder ?? undefined }
}

/**
 * Renew an existing lease the caller already holds. Same conditional UPDATE as
 * claim but only matches when `leaseHolder = me`. ok:false means we lost the lease
 * (another pager took over, or the active wake is gone) => the pager must stop
 * nudging.
 */
export async function renewLease(db: Db, input: ClaimLeaseInput): Promise<ClaimLeaseResult> {
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const expiresAt = new Date(Date.now() + ttl)

  const updated = await db
    .update(wakeIntents)
    .set({ leaseExpiresAt: expiresAt })
    .where(
      and(
        eq(wakeIntents.agentId, input.agentId),
        inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
        eq(wakeIntents.leaseHolder, input.holder),
        // The lease must still be VALID. An EXPIRED holder must not renew (or drive a
        // delivered-report): once expired the lease is up for grabs, and renewing it
        // would let a stale pager revive ownership and block a fresh claimant.
        sql`${wakeIntents.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ wakeId: wakeIntents.wakeId })

  if (updated.length > 0) return { ok: true, wakeId: updated[0].wakeId }
  return { ok: false }
}

/** Best-effort release: clear the lease only when we still hold it. */
export async function releaseLease(db: Db, input: { agentId: string; holder: string }): Promise<void> {
  await db
    .update(wakeIntents)
    .set({ leaseHolder: null, leaseExpiresAt: null })
    .where(
      and(
        eq(wakeIntents.agentId, input.agentId),
        eq(wakeIntents.leaseHolder, input.holder),
      ),
    )
}

export interface MarkDeliveredFencedResult {
  ok: boolean
  /** true when the reported wakeId does not match the agent's active pending wake. */
  stale?: boolean
  /** true on an idempotent re-report of a wake already past 'pending'. */
  already?: boolean
}

/**
 * Fencing transition: the pager reports "I nudged with this wakeId". Transition
 * pending -> delivered ONLY when the wakeId still matches the active wake.
 *
 * - matched & pending  => {ok:true} (delivered)
 * - not matched, but an active wake with that wakeId is already past pending
 *   => {ok:true, already:true} (idempotent at-least-once convergence)
 * - no match at all (settled / canceled / superseded by a newer wake)
 *   => {ok:false, stale:true} (ignored - a late report must not corrupt state)
 */
export async function markDeliveredFenced(
  db: Db,
  input: { agentId: string; wakeId: string },
): Promise<MarkDeliveredFencedResult> {
  // markDelivered is wakeId-keyed AND scoped to this agentId, so a caller holding
  // one agent's lease cannot transition a different agent's wake via its wakeId.
  const updated = await markDelivered(db, input.wakeId, input.agentId)
  if (updated) return { ok: true }

  // No pending row transitioned. Distinguish idempotent re-report (this wakeId is
  // the agent's still-active wake, just already delivered/activated) from truly
  // stale (no active wake with this id).
  const active = await activeWakeFor(db, input.agentId)
  if (active && active.wakeId === input.wakeId) {
    return { ok: true, already: true }
  }
  return { ok: false, stale: true }
}

export type IssueResult = { wakeId: string } | { suppressed: true }

export interface DecidePendingWakeInput {
  agentId: string
  /**
   * Wake-issuance function (05's `shouldWake`, budget-aware + coalescing). Injected
   * so this decision is testable and so the budget gate lives in one place. Returns
   * the issued wakeId, or { suppressed:true } when the budget denied it (05's
   * eligibility sweep recovers it when the window frees up).
   */
  issue: (agentId: string) => Promise<IssueResult>
}

export interface PendingWakeDecision {
  wake: boolean
  wakeId?: string
  subject?: string
  fromPart?: string
  /** informational unread count (used only in the nudge wording). */
  count?: number
  /** true when an issue was attempted but the budget suppressed it. */
  suppressed?: boolean
}

/**
 * Catch-up as a SINGLE coalesced decision (not per-unread-item). Replaces the
 * pager's old per-item enqueue from GET /unread. Messages stay in the inbox; this
 * only decides whether to wake this idle part ONCE.
 *
 *  1. active wake exists  -> return its wakeId + latest-unread subject/fromPart +
 *     total unread count (no new issue).
 *  2. no active wake, unread > 0  -> issue ONE coalesced wake (budget-gated).
 *  3. no unread  -> { wake:false }.
 *  4. budget suppressed  -> { wake:false, suppressed:true }.
 */
export async function decidePendingWake(
  db: Db,
  input: DecidePendingWakeInput,
): Promise<PendingWakeDecision> {
  const summary = await unreadSummary(db, input.agentId)

  const active = await activeWakeFor(db, input.agentId)
  if (active) {
    // The agent has caught up (nothing unread, or the only unread sits in a now-
    // closed thread which unreadSummary excludes), yet an active wake lingers
    // because reading an empty inbox never settles it. Settle it here and advance
    // the watermark, so the pager stops re-delivering the same wake id forever.
    if (summary.count === 0) {
      // Settle the stale wake (no watermark advance - see settleCaughtUp: it would
      // race a message landing in this window). Nothing unread => nothing to gate.
      await db.update(wakeIntents).set({ state: 'done', settledAt: new Date() }).where(eq(wakeIntents.id, active.id))
      return { wake: false }
    }
    return {
      wake: true,
      wakeId: active.wakeId,
      subject: summary.subject,
      fromPart: summary.fromPart,
      count: summary.count,
    }
  }

  if (summary.count === 0) return { wake: false }

  const issued = await input.issue(input.agentId)
  if ('suppressed' in issued) return { wake: false, suppressed: true }

  return {
    wake: true,
    wakeId: issued.wakeId,
    subject: summary.subject,
    fromPart: summary.fromPart,
    count: summary.count,
  }
}

/** Unread count + most-recent unread's subject/fromPart (reuses the /unread join). */
async function unreadSummary(db: Db, agentId: string) {
  const fromAgentsAlias = alias(agents, 'from_agents')
  const rows = await db
    .select({
      subject: threads.subject,
      fromPart: fromAgentsAlias.part,
      createdAt: messages.createdAt,
    })
    .from(messageRecipients)
    .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .leftJoin(fromAgentsAlias, eq(messages.fromAgentId, fromAgentsAlias.id))
    .where(and(
      eq(messageRecipients.agentId, agentId),
      isNull(messageRecipients.readAt),
      // A closed/canceled thread is resolved - its unread must not drive a wake
      // (the agent can't see it in inbox, so it would wake forever otherwise).
      sql`${threads.status} not in ('closed','canceled')`,
    ))
    .orderBy(desc(messages.createdAt))

  const top = rows[0]
  return {
    count: rows.length,
    subject: top?.subject as string | undefined,
    fromPart: (top?.fromPart ?? undefined) as string | undefined,
  }
}
