import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm"
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
 * DERIVED FROM THE COLUMN, never written out here. A hand-kept copy would be
 * correct today and silently wrong the day a fifth reason is added: this app would
 * keep compiling, the exhaustiveness check below would keep passing, and the new
 * value would arrive at runtime and render as its raw string. Deriving means the
 * schema is the only place the vocabulary exists, so adding one there breaks the
 * build here - which is the whole reason to have the check.
 *
 * Note this is NOT the server's WakeSuppressReason. That union is what the wake
 * decision RETURNS, a different and larger set: several of its values never
 * produce a row, and `loop_breaker`, which does, is not in it at all. Reading one
 * as the other is a mistake two people made independently in a single day, so the
 * column - the thing the writers actually fill - is the source.
 */
export type WakeSuppressionReason = NonNullable<typeof wakeEvents.$inferSelect["reason"]>

export interface WakeAuditSummary {
  total: number
  urgentCount: number
  suppressedCount: number
  windowHours: number
}

/**
 * `wake_event` answers two different questions, and they are asked with DIFFERENT
 * COLUMNS. This is the part that is easy to get wrong.
 *
 *  - `recipient`: a wake aimed at a part this user owns. Keyed by `ownerUserId`,
 *    with `agentId` naming the part.
 *  - `sender`: this user sent something and the loop breaker stopped it. Keyed by
 *    `senderUserId`, with NO `agentId` and NO `ownerUserId` - nothing was
 *    suppressed for anyone, a send was blocked by someone.
 *
 * They used to share `ownerUserId`, which is why the audit panel listed a blocked
 * send among a part's wakes. The server stopped writing the sender there, so the
 * two axes now need two queries with two gates. Asking for both with one
 * `ownerUserId = me` filter returns the sender axis EMPTY, always - which looks
 * exactly like "you have never had a send blocked" and is not a claim this app can
 * make.
 *
 * Each query carries its own isolation gate, deliberately, rather than one query
 * with an OR. A single gate is a sentence someone can check; two ORed conditions
 * in one predicate is a thing to reason about, and this table's whole history is
 * one column being read as two things.
 */
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
 * Audit (spec §10.6, §11): "who consumed my wake budget", plus the sends of this
 * user's that were blocked outright.
 *
 * TWO QUERIES, TWO GATES. `items` are wakes aimed at parts this user owns, gated
 * on `ownerUserId = userId`. `blockedSends` are this user's own sends that the
 * loop breaker stopped, gated on `senderUserId = userId` - a different column,
 * because the server records a blocked send against the sender and leaves
 * `ownerUserId` null. Filtering both with `ownerUserId` returns the second axis
 * permanently empty, which the UI would render as "nothing was ever blocked".
 *
 * `agentId` still separates them, and both conditions are stated on both sides:
 * the gate alone would be enough today, but stating it means neither query starts
 * returning the other's rows if a future writer sets both columns.
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
    const inWindow = [
      gte(wakeEvents.createdAt, since),
      ...(projectId ? [eq(wakeEvents.projectId, projectId)] : []),
    ]
    // The budget is per-owner and spans every project, so the owner gate is the
    // isolation boundary; projectId only narrows what is shown.
    const recipientGate = and(eq(wakeEvents.ownerUserId, userId), isNotNull(wakeEvents.agentId), ...inWindow)
    const senderGate = and(eq(wakeEvents.senderUserId, userId), isNull(wakeEvents.agentId), ...inWindow)

    const selection = {
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
    }
    const rowsFor = (gate: ReturnType<typeof and>) =>
      db
        .select(selection)
        .from(wakeEvents)
        .leftJoin(projects, eq(wakeEvents.projectId, projects.id))
        .leftJoin(agents, eq(wakeEvents.agentId, agents.id))
        .leftJoin(better_auth_user, eq(wakeEvents.senderUserId, better_auth_user.id))
        .where(gate)
        .orderBy(desc(wakeEvents.createdAt))
        .limit(200)

    // Summaries come from SQL, not from the row lists above, which are capped at
    // 200: a summary computed from a truncated list under-reports exactly when
    // there is most to report.
    const aggFor = (gate: ReturnType<typeof and>) =>
      db
        .select({
          total: count(),
          urgentCount: sql<number>`count(*) filter (where ${wakeEvents.urgent})`,
          suppressedCount: sql<number>`count(*) filter (where ${wakeEvents.suppressed})`,
        })
        .from(wakeEvents)
        .where(gate)

    const [rows, blockedSends, [agg], [senderAgg]] = await Promise.all([
      rowsFor(recipientGate),
      rowsFor(senderGate),
      aggFor(recipientGate),
      aggFor(senderGate),
    ])

    return {
      result: true,
      totalCount: rows.length,
      items: rows,
      summary: {
        total: Number(agg?.total ?? 0),
        urgentCount: Number(agg?.urgentCount ?? 0),
        suppressedCount: Number(agg?.suppressedCount ?? 0),
        windowHours,
      },
      blockedSends,
      blockedSendsSummary: {
        total: Number(senderAgg?.total ?? 0),
        urgentCount: Number(senderAgg?.urgentCount ?? 0),
        suppressedCount: Number(senderAgg?.suppressedCount ?? 0),
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
