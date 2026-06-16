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
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
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

/** Max candidates processed per tick (flood guard). Remainder picked up next tick. */
export const SWEEP_BATCH = 50

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
    sql`not ${activeWakeExists}`,
    // A closed/canceled thread is done - never re-wake for its unread messages.
    sql`${threads.status} not in ('closed','canceled')`,
    sql`(${agents.wakeWatermarkAt} is null or ${messages.createdAt} > ${agents.wakeWatermarkAt})`,
  ]
  if (opts.agentId) conditions.push(eq(agents.id, opts.agentId))

  const rows = await db
    .selectDistinctOn([agents.id], {
      agentId: agents.id,
      projectId: agents.projectId,
      projectSlug: projects.slug,
      part: agents.part,
      threadId: threads.id,
      messageId: messages.id,
      subject: threads.subject,
      createdAt: messages.createdAt,
    })
    .from(messageRecipients)
    .innerJoin(agents, eq(messageRecipients.agentId, agents.id))
    .innerJoin(messages, eq(messageRecipients.messageId, messages.id))
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .innerJoin(projects, eq(agents.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(agents.id, desc(messages.createdAt))
    .limit(limit)

  const candidates: Candidate[] = rows.map(r => ({
    agentId: r.agentId,
    projectId: r.projectId,
    projectSlug: r.projectSlug,
    part: r.part,
    threadId: r.threadId,
    messageId: r.messageId,
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
