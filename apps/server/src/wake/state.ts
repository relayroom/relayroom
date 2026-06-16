import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '@relayroom/db'
import { agents, wakeIntents } from '@relayroom/db'

/** Non-terminal states. Mirrors the partial unique index `wake_intent_agent_active`
 *  in packages/db/src/schema.ts (01). MUST stay in sync with that WHERE clause. */
export const ACTIVE_WAKE_STATES = ['pending', 'delivered', 'activated'] as const

/** Default reserve-refund deadline: spec 15.1 = 10 minutes. */
const WAKE_EXPIRY_MS = 10 * 60 * 1000

/** A row from wake_intent (drizzle inferred). */
export type WakeIntent = typeof wakeIntents.$inferSelect

export interface EnsurePendingInput {
  /** activation epoch this wake targets (fencing token vs stale activation). */
  epoch: number
  urgent?: boolean
  reason?: string
}

export interface EnsurePendingResult {
  intent: WakeIntent
  /** true only when THIS call inserted the row; false when an active wake already
   *  existed and we coalesced onto it (no-op). */
  created: boolean
}

/**
 * Atomically ensure there is an active wake_pending for `agentId`, creating one
 * IFF none is active. Coalescing is enforced by the partial unique index
 * `wake_intent_agent_active` (01): a second concurrent insert hits ON CONFLICT
 * DO NOTHING and we return the existing active row.
 *
 * NOTE: does NOT reserve budget. The wake-issuance choke point (05) wraps this
 * with reserve/settle. The epoch passed in is the agent's CURRENT activationEpoch
 * the wake targets (fencing vs stale activation).
 *
 * @returns the active intent + whether THIS call created it (created=false => no-op coalesce).
 */
export async function ensurePending(
  db: DbOrTx,
  agentId: string,
  input: EnsurePendingInput,
): Promise<EnsurePendingResult> {
  // Resolve owner principal + project for the budget/owner indexes on the row.
  const [agent] = await db
    .select({ projectId: agents.projectId, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  if (!agent) throw new Error(`ensurePending: unknown agentId ${agentId}`)

  const expiresAt = new Date(Date.now() + WAKE_EXPIRY_MS)

  const [created] = await db
    .insert(wakeIntents)
    .values({
      agentId,
      projectId: agent.projectId,
      ownerUserId: agent.ownerUserId ?? null,
      state: 'pending',
      epoch: input.epoch,
      urgent: input.urgent ?? false,
      reason: input.reason ?? null,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning()

  if (created) return { intent: created, created: true }

  // Conflict => an active wake already exists. Coalesce onto it (no-op).
  const [existing] = await db
    .select()
    .from(wakeIntents)
    .where(
      and(
        eq(wakeIntents.agentId, agentId),
        inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
      ),
    )
    .limit(1)
  if (!existing) {
    // Extremely narrow race: the active row settled between our insert-conflict
    // and this select. Retry once - now no active row should exist.
    return ensurePending(db, agentId, input)
  }
  return { intent: existing, created: false }
}

/**
 * Transition the active wake identified by wakeId from 'pending' to 'delivered'
 * and stamp deliveredAt. Idempotent: if the wake is not in 'pending' (already
 * delivered, activated, or terminal), this is a no-op and returns undefined.
 *
 * Keyed by wakeId (the fencing token handed to the pager), not agentId, so a
 * stale pager holding an old wakeId cannot mark a newer wake delivered. When
 * `agentId` is supplied it is ALSO required to match, so a caller holding agent A's
 * lease can never transition a different agent B's wake by supplying B's wakeId.
 */
export async function markDelivered(db: Db, wakeId: string, agentId?: string): Promise<WakeIntent | undefined> {
  const [updated] = await db
    .update(wakeIntents)
    .set({ state: 'delivered', deliveredAt: new Date() })
    .where(and(
      eq(wakeIntents.wakeId, wakeId),
      eq(wakeIntents.state, 'pending'),
      ...(agentId ? [eq(wakeIntents.agentId, agentId)] : []),
    ))
    .returning()
  return updated
}

export interface OnActivationResult {
  /** the agent's new activationEpoch after this turn-start (always incremented). */
  activationEpoch: number
  /** the wake that was cleared (state->done), or undefined if none active or stale-fenced. */
  cleared: WakeIntent | undefined
  /** true when an active wake existed but was NOT cleared due to epoch fencing. */
  fenced: boolean
}

/**
 * Report a turn-start activation for `agentId`. The activation carries the
 * activationEpoch the agent observed. ALWAYS bumps agents.activationEpoch
 * (a real turn started). Clears the active wake (state -> 'done', stamps
 * settledAt, advances agents.wakeWatermarkAt = now) ONLY when
 * activationEpoch >= wake.epoch (spec 4 stale-activation fencing).
 *
 * `ack` does NOT call this. Only a processed turn does. (spec 4)
 *
 * @param activationEpoch the epoch the agent reported at turn start.
 */
export async function onActivation(
  db: Db,
  agentId: string,
  activationEpoch: number,
): Promise<OnActivationResult> {
  // Find the current active wake (at most one, per the invariant).
  const [active] = await db
    .select()
    .from(wakeIntents)
    .where(
      and(
        eq(wakeIntents.agentId, agentId),
        inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
      ),
    )
    .limit(1)

  // Always advance the agent's activation epoch (a turn really started).
  const [agentRow] = await db
    .update(agents)
    .set({ activationEpoch: sql`${agents.activationEpoch} + 1` })
    .where(eq(agents.id, agentId))
    .returning({ activationEpoch: agents.activationEpoch })
  if (!agentRow) throw new Error(`onActivation: unknown agentId ${agentId}`)

  if (!active) {
    return { activationEpoch: agentRow.activationEpoch, cleared: undefined, fenced: false }
  }

  // Epoch fencing: a stale activation (older than the wake's target epoch) must
  // NOT clear a newer wake.
  if (activationEpoch < active.epoch) {
    return { activationEpoch: agentRow.activationEpoch, cleared: undefined, fenced: true }
  }

  // Clear: settle the wake and advance the watermark.
  const now = new Date()
  const [cleared] = await db
    .update(wakeIntents)
    .set({ state: 'done', settledAt: now })
    .where(eq(wakeIntents.id, active.id))
    .returning()
  await db
    .update(agents)
    .set({ wakeWatermarkAt: now })
    .where(eq(agents.id, agentId))

  return { activationEpoch: agentRow.activationEpoch, cleared, fenced: false }
}

/**
 * Mark active wakes (pending/delivered) past their expiresAt as 'expired'.
 * Returns the expired rows so the budget engine (03) can refund their reserves.
 * Does NOT touch 'activated' (a turn is already in flight; onActivation settles it).
 *
 * Idempotent and safe to run from the periodic sweep + pager heartbeat (spec 5).
 */
export async function expireStale(db: Db, now: Date = new Date()): Promise<WakeIntent[]> {
  return db
    .update(wakeIntents)
    .set({ state: 'expired' })
    .where(
      and(
        inArray(wakeIntents.state, ['pending', 'delivered']),
        lt(wakeIntents.expiresAt, now),
      ),
    )
    .returning()
}

/**
 * Settle every active wake for an agent that has caught up. This is the
 * agent-driven completion that onActivation was meant to be but was never wired
 * in: the agent's MCP flow (ack/inbox, once it has 0 unread) calls this, so a
 * delivered wake actually ENDS instead of being re-delivered forever by the pager.
 *
 * Deliberately does NOT advance wakeWatermarkAt. It only runs at 0 unread, so there
 * is nothing for the watermark to gate; and advancing it to wall-clock `now` would
 * race a message that lands in the same window (its wake would be settled here AND
 * gated out by the watermark = lost). Leaving the watermark alone makes the sweep,
 * which keys on unread readAt, recover any such message. Idempotent.
 */
export async function settleCaughtUp(db: Db, agentId: string, now: Date = new Date()): Promise<number> {
  const settled = await db
    .update(wakeIntents)
    .set({ state: 'done', settledAt: now })
    .where(and(
      eq(wakeIntents.agentId, agentId),
      inArray(wakeIntents.state, ACTIVE_WAKE_STATES as unknown as string[]),
    ))
    .returning()
  return settled.length
}
