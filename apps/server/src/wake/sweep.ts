/**
 * Eligibility / refill sweep (phase 05).
 *
 * Recovers idle parts whose wake was suppressed (budget exhausted) once the rolling
 * window frees up, so there is no infinite sleep (spec 5). A part is a candidate when:
 *   - it is IDLE (no active wake_intent - coalescing invariant), AND
 *   - it has PENDING UNREAD addressed to it (messageRecipients.readAt IS NULL on a
 *     message created after the agent's wakeWatermarkAt - 02 owns the watermark), AND
 *   - its owner's budget is available NOW (re-evaluated by shouldWake).
 *
 * Each candidate goes through `shouldWake` (THE choke point) so part-per-wake
 * coalescing and the budget gate are enforced uniformly. On `issue` we signal the
 * pager via `issueWake` using the part's most recent unread message.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Bus } from '../bus'
import type { Db } from '@relayroom/db'
import {
  agents,
  messageRecipients,
  messages,
  projects,
  threads,
  wakeIntents,
} from '@relayroom/db'
import { issueWake, shouldWake } from './issuance'

/** Max candidates processed per tick (flood guard). */
export const SWEEP_BATCH = 50

/**
 * Slots one owner is guaranteed in a tick, however many owners there are. The cap
 * is `max(this, SWEEP_BATCH / owners)`, so a single-owner instance still gets the
 * whole batch and nothing changes for it.
 */
export const SWEEP_PER_OWNER_FLOOR = 5

export interface SweepOptions {
  /** Restrict the sweep to a single agent (heartbeat trigger). */
  agentId?: string
  /** Override batch size (tests). */
  limit?: number
}

export interface SweepResult {
  candidates: number // idle+unread parts evaluated
  issued: number // wakes actually issued + signaled this tick
}

interface Candidate {
  agentId: string
  projectId: string
  projectSlug: string
  part: string
  // representative unread message for the pager signal
  threadId: string
  messageId: string
  subject: string
}

/**
 * Run one sweep tick. Finds idle parts with pending unread whose budget is now
 * available, and re-issues a coalesced wake for each via `shouldWake`.
 */
export async function runEligibilitySweep(
  db: Db,
  bus: Bus,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const limit = opts.limit ?? SWEEP_BATCH

  // Idle = no active wake_intent. Express as a NOT EXISTS correlated subquery.
  const activeWakeExists = sql`exists (
    select 1 from ${wakeIntents} wi
    where wi.agent_id = ${agents.id}
      and wi.state in ('pending','delivered','activated')
  )`

  // One representative unread message per agent (the most recent), gated on the
  // agent's wakeWatermarkAt (null watermark = everything counts).
  const conditions = [
    isNull(messageRecipients.readAt),
    // Never sweep-wake a soft-deleted agent (a removed part must stay removed).
    isNull(agents.deletedAt),
    // An agent with no owner is refused by shouldWake ('no_owner') every time, so
    // including it only burns a slot in the capped batch.
    sql`${agents.ownerUserId} is not null`,
    sql`not ${activeWakeExists}`,
    // A closed/canceled thread is done - never re-wake for its unread messages.
    sql`${threads.status} not in ('closed','canceled')`,
    sql`(${agents.wakeWatermarkAt} is null or ${messages.createdAt} > ${agents.wakeWatermarkAt})`,
  ]
  if (opts.agentId) conditions.push(eq(agents.id, opts.agentId))

  // The batch is instance-wide but the wake budget is per owner, and a
  // budget-suppressed agent stays idle+unread - so it stays a candidate. Ordering
  // by agent id (uuidv7, i.e. oldest first) therefore let ONE owner with 50+
  // exhausted agents hold the whole batch permanently, and a different owner whose
  // budget was untouched never got evaluated at all. Measured: 5 ticks, 55 agents
  // on an exhausted owner, 0 of 5 agents woken for a second owner; the same agent
  // woke immediately when the batch was bypassed.
  //
  // So: cap how many slots one owner can take, and order by how long an agent has
  // been waiting rather than by how old its row is.
  //
  // THIS TRADES STARVATION FOR THROUGHPUT, it does not eliminate waste. The slots a
  // suppressed owner takes are still spent on agents that will be suppressed again
  // this tick. With several exhausted owners, most of a batch can be spent that way.
  // That is the intended trade - a slow queue beats a queue somebody never joins -
  // but it is a trade, not a fix, and the next person looking at sweep throughput
  // should know it was chosen deliberately.
  //
  // The root fix is to leave agents whose owner has no budget out of the candidate
  // set entirely. Not done here: the budget is a rolling-window aggregate over
  // wake_event (see budget.ts countWindow), and folding that into a query that runs
  // every 30 seconds costs more than the wasted slots do.
  //
  // Cost of the rewrite, measured on a seeded database (EXPLAIN ANALYZE):
  //   400 agents  : 0.4ms -> 4.3ms      5,400 agents: 0.8ms -> 16.9ms
  // The window functions have to see every candidate, so the old plan's ability to
  // stop after 50 index rows is gone. At 17ms per 30s tick that is noise. Capping
  // WITHOUT changing the sort key was also measured and came out slower (26.8ms),
  // so there was nothing to be gained by splitting the two changes up.
  const rows = await db.execute<{
    agent_id: string
    project_id: string
    project_slug: string
    part: string
    thread_id: string
    message_id: string
    subject: string
  }>(sql`
    with unread as (
      select
        ${agents.id} as agent_id,
        ${agents.projectId} as project_id,
        ${agents.ownerUserId} as owner_user_id,
        ${projects.slug} as project_slug,
        ${agents.part} as part,
        ${threads.id} as thread_id,
        ${messages.id} as message_id,
        ${threads.subject} as subject,
        ${messages.createdAt} as created_at,
        min(${messages.createdAt}) over (partition by ${agents.id}) as oldest_unread
      from ${messageRecipients}
      inner join ${agents} on ${messageRecipients.agentId} = ${agents.id}
      inner join ${messages} on ${messageRecipients.messageId} = ${messages.id}
      inner join ${threads} on ${messages.threadId} = ${threads.id}
      inner join ${projects} on ${agents.projectId} = ${projects.id}
      where ${and(...conditions)}
    ),
    per_agent as (
      -- Representative message per agent: the newest unread, as before. The nudge
      -- quotes it; oldest_unread is what decides the agent's place in the queue.
      select distinct on (agent_id) * from unread order by agent_id, created_at desc
    ),
    ranked as (
      select *,
        row_number() over (
          partition by owner_user_id order by oldest_unread asc, agent_id asc
        ) as owner_rn,
        -- Owner count without a second round trip: count(distinct) is not allowed
        -- in a window function, so rank the owners here and take the max below.
        dense_rank() over (order by owner_user_id) as owner_rank
      from per_agent
    ),
    capped as (select *, max(owner_rank) over () as owner_count from ranked)
    select agent_id, project_id, project_slug, part, thread_id, message_id, subject
    from capped
    -- Ceiling, not floor: with 3 owners and a batch of 50, floor gives 16 each and
    -- the batch can only ever reach 48. Rounding up lets the batch fill while still
    -- bounding any single owner.
    where owner_rn <= greatest(${SWEEP_PER_OWNER_FLOOR}, ceil(${limit}::numeric / owner_count)::int)
    -- agent_id last so the order is total: equal wait times are common in seeded
    -- data and would otherwise make the batch nondeterministic.
    order by oldest_unread asc, agent_id asc
    limit ${limit}
  `)

  const candidates: Candidate[] = rows.map(r => ({
    agentId: r.agent_id,
    projectId: r.project_id,
    projectSlug: r.project_slug,
    part: r.part,
    threadId: r.thread_id,
    messageId: r.message_id,
    subject: r.subject,
  }))

  let issued = 0
  for (const cand of candidates) {
    const decision = await shouldWake(db, cand.agentId, { reason: 'sweep' })
    if (decision.action !== 'issue') continue
    issueWake(bus, {
      projectId: cand.projectId,
      projectSlug: cand.projectSlug,
      part: cand.part,
      threadId: cand.threadId,
      messageId: cand.messageId,
      subject: cand.subject,
      fromPart: 'system',
      wakeId: decision.wakeId,
    })
    issued++
  }

  return { candidates: candidates.length, issued }
}
