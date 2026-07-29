import { and, count, desc, eq, gte, sql } from "drizzle-orm"
import type { ApiResultWithItem, ApiResultWithItems } from "@relayroom/shared"
import { db } from "@/modules/drizzle/db"
import { wakeEvents, ownerWakeBudgets, projects, agents } from "@relayroom/db/schema"
import { better_auth_user } from "@relayroom/db/auth-schema"
import { getErrorTranslations } from "@/lib/action-i18n"

// Spec §15.1 defaults applied when an owner has not set a budget yet.
const DEFAULT_WAKES_PER_HOUR = 30
const DEFAULT_URGENT_PER_HOUR = 5

export interface OwnerWakeBudget {
  wakesPerHour: number
  urgentPerHour: number
  /** true = no row yet, the spec §15.1 defaults are in effect. */
  isDefault: boolean
}

/**
 * Current budget for the logged-in owner, seeding the sliders. No row means the
 * owner has never configured it, so the spec §15.1 defaults (30/5) are returned
 * with isDefault=true.
 */
export async function getOwnerWakeBudget(
  userId: string,
): Promise<ApiResultWithItem<OwnerWakeBudget>> {
  const t = await getErrorTranslations()
  try {
    const [row] = await db
      .select({
        wakesPerHour: ownerWakeBudgets.wakesPerHour,
        urgentPerHour: ownerWakeBudgets.urgentPerHour,
      })
      .from(ownerWakeBudgets)
      .where(eq(ownerWakeBudgets.userId, userId))
      .limit(1)

    if (!row) {
      return {
        result: true,
        item: {
          wakesPerHour: DEFAULT_WAKES_PER_HOUR,
          urgentPerHour: DEFAULT_URGENT_PER_HOUR,
          isDefault: true,
        },
      }
    }
    return {
      result: true,
      item: {
        wakesPerHour: Number(row.wakesPerHour),
        urgentPerHour: Number(row.urgentPerHour),
        isDefault: false,
      },
    }
  } catch (err) {
    console.error("[getOwnerWakeBudget]", err)
    return { result: false, message: t("wake.budgetLoadFailed") }
  }
}

export interface WakeAuditRow {
  id: string
  createdAt: Date
  senderPart: string | null
  senderUserId: string | null
  senderName: string | null
  projectId: string | null
  projectName: string | null
  agentId: string | null
  agentPart: string | null
  urgent: boolean
  /** true = the wake was not fired. `reason` says why. NOT a charged consume. */
  suppressed: boolean
  /**
   * Why the wake was suppressed. Null on an issued wake (there is no reason to
   * give for something that happened) and on suppressions recorded before the
   * writers started stamping one, which is why the UI reads it together with
   * `suppressed` rather than alone.
   */
  reason: WakeSuppressionReason | null
}

/**
 * The suppression reasons that actually reach `wake_event.reason`.
 *
 * Deliberately not derived from the server's WakeSuppressReason: that union is
 * what the wake decision RETURNS, which is a different and larger set - several of
 * its values never produce a row at all. Reading it as this vocabulary is a
 * mistake two people made independently, so this list is the persisted one, and
 * nothing in this app should offer a filter or a label for anything outside it.
 */
export const WAKE_SUPPRESSION_REASONS = [
  "budget_exhausted",
  "limited",
  "loop_breaker",
  "direct_cooldown",
] as const
export type WakeSuppressionReason = (typeof WAKE_SUPPRESSION_REASONS)[number]

export interface WakeAuditSummary {
  total: number
  urgentCount: number
  suppressedCount: number
  windowHours: number
}

/**
 * `wake_event` holds two different statements under one `ownerUserId` column, and
 * telling them apart is not optional - they have different subjects.
 *
 *  - `recipient`: a wake aimed at a part this user owns. ownerUserId is the part's
 *    owner, and `agentId` names the part.
 *  - `sender`: this user sent something and the loop breaker stopped it
 *    (`pipeline.ts` writes ownerUserId = the SENDER, and no agentId at all).
 *
 * So a row saying "suppressed" can mean "a part of mine was not woken" or "a send
 * of mine was blocked", and listing them together reads as the first for both. The
 * agent-detail audit panel has been doing exactly that: a loop-breaker row appeared
 * in the part's list with no part on it.
 *
 * The discriminator is `agentId`, not `reason`. That is deliberate - it holds
 * whatever the reason vocabulary turns out to be, and the vocabulary is being
 * reworked. A row about a part has a part; a row about a send does not.
 *
 * ONE PLACE ON PURPOSE. Everything downstream consumes the split result, never the
 * raw rows, so when the server exposes an axis-aware read this function is the only
 * thing that changes.
 */
export interface WakeAuditAxes {
  /** Wakes aimed at parts this owner runs. */
  recipient: WakeAuditRow[]
  /** Sends by this user that were blocked before reaching anyone. */
  sender: WakeAuditRow[]
}

function splitByAxis(rows: WakeAuditRow[]): WakeAuditAxes {
  const recipient: WakeAuditRow[] = []
  const sender: WakeAuditRow[] = []
  for (const row of rows) {
    if (row.agentId) recipient.push(row)
    else sender.push(row)
  }
  return { recipient, sender }
}

export interface PartSuppression {
  agentId: string
  part: string
  /** Suppressions in the window, by reason. Only reasons with a count appear. */
  byReason: { reason: WakeSuppressionReason | null; count: number }[]
  total: number
}

/**
 * Which of this owner's parts had wakes suppressed in a project, and why.
 *
 * The existing audit panel lives on an agent's own page, so it answers "why was
 * THIS part quiet" - useful only once you already know which part to open. The
 * incident this is for looks the other way round: several parts sit idle and
 * nothing says which one to look at, because a suppressed wake leaves no trace
 * anywhere the operator is looking. So this groups by part and starts from the
 * project.
 *
 * Recipient axis only (`agentId is not null`). A blocked send has no part to group
 * under and is a statement about the sender, not about a part going quiet.
 *
 * WHAT THIS CANNOT SHOW, and it matters that the screen says so:
 *  - Coalesced wakes (a wake was already pending) write no row. That is correct -
 *    the part was not silenced - but it means this is not a complete record of
 *    every wake decision, only of the ones that withheld a nudge.
 *  - `limited` is recorded only on sender-attributed paths. The 30-second sweep
 *    re-evaluates a parked part every tick and deliberately writes nothing, so the
 *    count here is "sends blocked by a provider limit", not "times this part was
 *    unreachable".
 */
export async function listProjectSuppressions(
  projectId: string,
  userId: string,
  windowHours: number,
): Promise<ApiResultWithItems<PartSuppression>> {
  const t = await getErrorTranslations()
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
    const rows = await db
      .select({
        agentId: wakeEvents.agentId,
        part: agents.part,
        reason: wakeEvents.reason,
        count: count(),
      })
      .from(wakeEvents)
      .innerJoin(agents, eq(wakeEvents.agentId, agents.id))
      .where(
        and(
          eq(wakeEvents.ownerUserId, userId),
          eq(wakeEvents.projectId, projectId),
          eq(wakeEvents.suppressed, true),
          gte(wakeEvents.createdAt, since),
        ),
      )
      .groupBy(wakeEvents.agentId, agents.part, wakeEvents.reason)

    const byAgent = new Map<string, PartSuppression>()
    for (const r of rows) {
      if (!r.agentId) continue
      const entry = byAgent.get(r.agentId) ?? {
        agentId: r.agentId,
        part: r.part,
        byReason: [],
        total: 0,
      }
      const n = Number(r.count)
      entry.byReason.push({ reason: r.reason, count: n })
      entry.total += n
      byAgent.set(r.agentId, entry)
    }

    const items = [...byAgent.values()].sort((a, b) => b.total - a.total)
    return { result: true, items, totalCount: items.length }
  } catch (err) {
    console.error("[listProjectSuppressions]", err)
    return { result: false, message: t("wake.auditLoadFailed") }
  }
}

/**
 * Audit (spec §10.6, §11): "who consumed my wake budget". Returns ONLY the
 * logged-in owner's wakeEvents (ownerUserId === userId) within the window, newest
 * first. The `ownerUserId = userId` predicate is the SOLE isolation gate - no
 * other owner's events can leak in.
 *
 * Returned on two axes, because `ownerUserId` does not mean one thing: `items` are
 * wakes aimed at this owner's parts, `blockedSends` are this user's own sends that
 * the loop breaker stopped. See splitByAxis above for why they cannot share a list.
 */
export async function listOwnerWakeAudit(
  userId: string,
  windowHours: number,
  projectId?: string,
): Promise<
  ApiResultWithItems<WakeAuditRow> & {
    summary: WakeAuditSummary
    blockedSends: WakeAuditRow[]
    blockedSendsSummary: WakeAuditSummary
  }
> {
  const t = await getErrorTranslations()
  const emptySummary: WakeAuditSummary = {
    total: 0,
    urgentCount: 0,
    suppressedCount: 0,
    windowHours,
  }
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
    // ownerUserId is the budget-isolation gate (budgets are per-owner, spanning all
    // their projects). When a projectId is passed (e.g. on a project's agent page),
    // also scope to that project so the list isn't mixed with other projects' wakes.
    const ownerGate = and(
      eq(wakeEvents.ownerUserId, userId),
      gte(wakeEvents.createdAt, since),
      ...(projectId ? [eq(wakeEvents.projectId, projectId)] : []),
    )

    const rows = await db
      .select({
        id: wakeEvents.id,
        createdAt: wakeEvents.createdAt,
        senderPart: wakeEvents.senderPart,
        senderUserId: wakeEvents.senderUserId,
        senderName: better_auth_user.name,
        projectId: wakeEvents.projectId,
        projectName: projects.name,
        agentId: wakeEvents.agentId,
        agentPart: agents.part,
        urgent: wakeEvents.urgent,
        suppressed: wakeEvents.suppressed,
        reason: wakeEvents.reason,
      })
      .from(wakeEvents)
      .leftJoin(projects, eq(wakeEvents.projectId, projects.id))
      .leftJoin(agents, eq(wakeEvents.agentId, agents.id))
      .leftJoin(better_auth_user, eq(wakeEvents.senderUserId, better_auth_user.id))
      .where(ownerGate)
      .orderBy(desc(wakeEvents.createdAt))
      .limit(200)

    const [agg] = await db
      .select({
        total: count(),
        urgentCount: sql<number>`count(*) filter (where ${wakeEvents.urgent})`,
        suppressedCount: sql<number>`count(*) filter (where ${wakeEvents.suppressed})`,
        // Counted per axis for the same reason the rows are split - a total that
        // mixes "a part of mine was not woken" with "a send of mine was blocked"
        // describes neither. Counted in SQL rather than from `rows`, which is
        // capped at 200: a summary computed from a truncated list would quietly
        // under-report exactly when there is most to report.
        senderTotal: sql<number>`count(*) filter (where ${wakeEvents.agentId} is null)`,
        senderSuppressed: sql<number>`count(*) filter (where ${wakeEvents.agentId} is null and ${wakeEvents.suppressed})`,
        senderUrgent: sql<number>`count(*) filter (where ${wakeEvents.agentId} is null and ${wakeEvents.urgent})`,
      })
      .from(wakeEvents)
      .where(ownerGate)

    const axes = splitByAxis(rows)
    const senderTotal = Number(agg?.senderTotal ?? 0)

    return {
      result: true,
      totalCount: axes.recipient.length,
      // `items` and `summary` are the RECIPIENT axis - wakes aimed at this owner's
      // parts, which is what every existing consumer meant by them.
      items: axes.recipient,
      summary: {
        total: Number(agg?.total ?? 0) - senderTotal,
        urgentCount: Number(agg?.urgentCount ?? 0) - Number(agg?.senderUrgent ?? 0),
        suppressedCount: Number(agg?.suppressedCount ?? 0) - Number(agg?.senderSuppressed ?? 0),
        windowHours,
      },
      blockedSends: axes.sender,
      blockedSendsSummary: {
        total: senderTotal,
        urgentCount: Number(agg?.senderUrgent ?? 0),
        suppressedCount: Number(agg?.senderSuppressed ?? 0),
        windowHours,
      },
    }
  } catch (err) {
    console.error("[listOwnerWakeAudit]", err)
    return {
      result: false,
      message: t("wake.auditLoadFailed"),
      summary: emptySummary,
      blockedSends: [],
      blockedSendsSummary: emptySummary,
    }
  }
}
